"""Behavior from the ADA Mobile spec: scene math, models, safety, keys."""

import time

from mobile_behavior import (
    KeyRotator,
    camera_prompt,
    clamp_minutes,
    cost_warning,
    film_progress,
    generate_enabled,
    interaction_body,
    is_retryable_key_error,
    is_unsupported_model,
    mask_key,
    migrate_live_model,
    migrate_text_model,
    migrate_video_model,
    one_less_scene_falls_short,
    parse_finished_request,
    parse_interaction,
    parse_storyboard,
    rank_models,
    scene_count_for_minutes,
    should_retry_safety,
    started_line,
    stitched_ms,
    video_user_line,
    wants_make_it,
)
from gemini_key_store import GeminiKeyStore
from omni_film import OmniError, build_ffmpeg_command, crossfade_filter, render_omni_clip, wav_header


class FakeHttp:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, method, url, headers=None, body=None, timeout=120):
        self.calls.append({"method": method, "url": url, "body": body, "headers": headers})
        status, payload = self.responses.pop(0)
        return _Result(status, payload)


class _Result:
    def __init__(self, status, payload):
        self.status = status
        self._payload = payload
        if isinstance(payload, bytes):
            self.body = payload
        else:
            import json
            self.body = json.dumps(payload).encode("utf-8")

    def json(self):
        import json
        return json.loads(self.body.decode("utf-8"))

    def text(self):
        return self.body.decode("utf-8")


class MemStore:
    def __init__(self):
        self.data = {}
        self._prefer_keyring = True

    def load(self):
        return dict(self.data)

    def save(self, data):
        self.data = dict(data)


def test_scene_counts_match_the_spec():
    assert scene_count_for_minutes(1) == 8
    assert scene_count_for_minutes(2) == 16
    assert stitched_ms(8) == 61200
    assert stitched_ms(16) == 122000
    for minutes in range(1, 11):
        assert one_less_scene_falls_short(minutes)


def test_minutes_clamp_and_cost_copy():
    assert clamp_minutes("2") == 2
    assert clamp_minutes("99") == 10
    assert clamp_minutes("") == 1
    warning = cost_warning(1)
    assert "8 scenes of 8 seconds" in warning
    assert "the computer stitches" in warning
    assert "long render" not in warning
    assert "long render" in cost_warning(2)


def test_voice_request_fills_the_studio():
    parsed = parse_finished_request("make a 2 minute motivation short, anime style")
    assert parsed["minutes"] == 2
    assert parsed["niche"] == "Motivation"
    assert parsed["style"] == "Anime"
    assert parsed["aspect"] == "9:16 Shorts"
    assert parsed["narrator"] == "Storyteller"
    wide = parse_finished_request("widescreen educational about ocean tides, deep male")
    assert wide["aspect"].startswith("16")
    assert wide["niche"] == "Educational"
    assert wide["narrator"] == "Deep Male"
    assert "ocean tides" in wide["topic"]
    custom = parse_finished_request("niche fitness")
    assert custom["custom_niche"] == "Fitness"


def test_started_line_names_the_model_plan():
    line = started_line(2, "Motivation", "Anime", "9:16 Shorts")
    assert "16 scenes" in line
    assert "Movies/ADA" in line
    assert "Sir" in line


def test_make_it_phrases():
    assert wants_make_it("please make the video")
    assert not wants_make_it("Make it.")
    assert wants_make_it("shoot a video of the shop")


def test_storyboard_pads_and_trims():
    raw = '{"title":"Spark","scenes":[{"visual":"A door","narration":"Come in, honey","caption":"Come in"}]}'
    board = parse_storyboard(raw, 3, "the shop", "Anime")
    assert len(board["scenes"]) == 3
    assert board["scenes"][0]["caption"] == "Come in"
    assert "honey" in board["scenes"][1]["narration"]
    fenced = "```json\n" + raw + "\n```"
    assert parse_storyboard(fenced, 1)["title"] == "Spark"
    empty = parse_storyboard("not json", 4, "tides", "Cinematic")
    assert len(empty["scenes"]) == 4


def test_camera_prompt_uses_the_style_look():
    prompt = camera_prompt("A lantern boat", "Anime")
    assert prompt.startswith("A lantern boat")
    assert "Anime cel-shaded" in prompt
    assert "no watermark" in prompt


def test_model_migration_and_ranking():
    assert migrate_live_model("") == "gemini-3.8-live"
    assert migrate_live_model("gemini-2.5-flash-native-audio-preview-12-2025") == "gemini-3.8-live"
    assert migrate_live_model("gemini-3.1-flash-live-preview") == "gemini-3.1-flash-live-preview"
    assert migrate_text_model("gemini-2.0-flash") == "gemini-3.8-flash"
    assert migrate_text_model("gemini-2.5-flash") == "gemini-2.5-flash"
    assert migrate_video_model("veo-3.1-generate-preview") == "gemini-omni-1.1-flash"
    discovered = [
        {"name": "models/gemini-omni-1.1-flash-preview", "description": "video"},
        {"name": "models/gemini-omni-1.1-flash", "description": "video generation"},
        {"name": "models/veo-2.0-generate-001", "description": "video generation"},
        {"name": "models/gemini-something-video", "description": "video generation model"},
    ]
    order = rank_models(discovered, "video")
    assert order[0] == "gemini-omni-1.1-flash"
    assert order[1] == "gemini-omni-1.1-flash-preview"
    assert "veo-2.0-generate-001" not in order
    assert rank_models([], "live")[0] == "gemini-3.8-live"


def test_unsupported_does_not_match_safety_and_does_not_rotate_keys():
    sentence = "This feature is not supported anymore."
    assert is_unsupported_model(f"gemini-omni-1.1-flash: {sentence}")
    assert not is_unsupported_model("The scene was blocked by safety policy.")
    assert not is_retryable_key_error("model is not supported", 400)
    assert not is_retryable_key_error("blocked by safety", 400)
    assert is_retryable_key_error("quota exceeded", 429)
    assert is_retryable_key_error("unavailable", 503)
    line = video_user_line("unsupported", sentence, "gemini-omni-1.1-flash")
    assert "gemini-omni-1.1-flash" in line
    assert "not supported anymore" in line


def test_key_rotation_skips_a_cooling_key():
    now = {"t": 1000.0}
    ring = KeyRotator(["one-key-aaa", "two-key-bbb"], cooldown_seconds=90, clock=lambda: now["t"])
    first = ring.acquire()
    ring.cool(first["slot"])
    second = ring.acquire()
    assert second["slot"] != first["slot"]
    ring.cool(second["slot"])
    try:
        ring.acquire()
        assert False, "both keys should be cooling"
    except RuntimeError as exc:
        assert "cooling down" in str(exc)
    now["t"] += 91
    assert ring.acquire()["slot"] in {1, 2}
    assert mask_key("AIzaSecret7kQ").startswith("AIza")
    assert "Secret" not in mask_key("AIzaSecret7kQ")


def test_saved_keys_round_trip_without_leaking_into_the_public_view():
    store = MemStore()
    book = GeminiKeyStore(store, env_keys=["env-key-zzzz"])
    assert book.add("short")
    assert book.add("AIzaSavedKey7kQ") == ""
    view = book.public_view()
    blob = str(view)
    assert "AIzaSavedKey7kQ" not in blob
    assert "env-key-zzzz" not in blob
    assert any(row["source"] == "saved" for row in view["keys"])
    saved_slot = next(row["slot"] for row in view["keys"] if row["source"] == "saved")
    assert book.delete_slot(saved_slot)
    assert all(row["source"] != "saved" for row in book.public_view()["keys"])


def test_interaction_body_requires_text_to_video():
    body = interaction_body("gemini-omni-1.1-flash", "A lantern boat", "9:16")
    assert body["generation_config"]["video_config"]["task"] == "text_to_video"
    assert body["response_format"]["duration"] == "8s"
    assert "background" not in body


def test_text_only_completion_is_surfaced():
    payload = {"status": "completed", "steps": [{"text": "This feature is not supported anymore"}]}
    parsed = parse_interaction(payload)
    assert not parsed["ok"]
    assert "not supported anymore" in parsed["text"]


def test_unsupported_model_tries_the_next_and_safety_stops():
    http = FakeHttp([
        (400, {"error": {"message": "gemini-omni-1.1-flash is not supported anymore"}}),
        (200, {"status": "completed", "uri": "https://example.test/clip.mp4"}),
    ])
    rendered = render_omni_clip("boat", "test-key", http=http, models=["gemini-omni-1.1-flash", "gemini-omni-1.1-flash-preview"])
    assert rendered["parsed"]["uri"].endswith("clip.mp4")
    assert len(http.calls) == 2
    safety = FakeHttp([(400, {"error": {"message": "blocked by safety policy"}})])
    try:
        render_omni_clip("boat", "test-key", http=safety, models=["gemini-omni-1.1-flash", "gemini-omni-1.1-flash-preview"])
        assert False, "safety should stop the model loop"
    except OmniError as exc:
        assert exc.kind == "safety"
        assert len(safety.calls) == 1


def test_identical_rewrite_is_not_retried():
    assert not should_retry_safety("same scene", "same scene")
    assert not should_retry_safety("same scene", "  ")
    assert should_retry_safety("blocked scene", "a quiet boat")


def test_ffmpeg_plan_fades_between_clips():
    graph = crossfade_filter(2)
    assert "fadeblack" in graph
    assert "offset=7.600" in graph
    command = build_ffmpeg_command(["a.mp4", "b.mp4"], "out.mp4", voice_path="voice.wav", crossfade=True)
    assert command[0] == "ffmpeg"
    assert "voice.wav" in command
    assert "fadeblack" in " ".join(command)


def test_pcm_wraps_as_wav():
    wav = wav_header(b"\x00\x00" * 10)
    assert wav.startswith(b"RIFF")
    assert wav[8:12] == b"WAVE"


def test_mouth_follows_playback_only():
    from mobile_behavior import mouth_shape, normalize_assistant_look, quantize_playback_level
    rest = {"openness": 0.08, "width": 0.72}
    assert mouth_shape(False, 1) == rest
    assert mouth_shape(True, 0.04) == rest
    full = mouth_shape(True, 1)
    assert full["openness"] == 1
    assert abs(full["width"] - 0.50) < 1e-9
    loud = int.from_bytes((20000).to_bytes(2, "little", signed=True), "little", signed=True)
    pcm = (20000).to_bytes(2, "little", signed=True) * 8
    level = quantize_playback_level(pcm)
    assert 0 < level <= 1
    assert abs(level * 32 - round(level * 32)) < 1e-9
    assert quantize_playback_level(b"") == 0
    assert normalize_assistant_look(" ORB ") == "orb"
    assert normalize_assistant_look("") == "sweety"
    assert normalize_assistant_look("face") == "sweety"
    fraction, label = film_progress("Rendering", 3, 16)
    assert label == "Rendering scene 3 of 16"
    assert 0.1 <= fraction < 0.65
    assert generate_enabled("Ready")
    assert not generate_enabled("Rendering")
    assert film_progress("Error")[1] == "Cancelled."
