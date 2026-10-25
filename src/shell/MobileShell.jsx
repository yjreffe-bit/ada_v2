import { useEffect, useMemo, useRef, useState } from 'react';
import {
    ArrowLeft, Camera, Clapperboard, Home, Library, MemoryStick, Mic, MonitorUp,
    Send, Settings, Square, Trash2, Cpu, Printer, Globe, Video,
} from 'lucide-react';
import SweetyFace from './SweetyFace';
import OrbMark from './OrbMark';
import { normalizeLook } from './sweetyMath';
import SettingsWindow from '../components/SettingsWindow';

const VOICES = ['Kore', 'Aoede', 'Puck', 'Charon', 'Fenrir', 'Leda', 'Orus', 'Zephyr'];
const NARRATION = ['Sulafat', 'Kore', 'Aoede', 'Zephyr', 'Puck', 'Callirrhoe'];
const NICHES = ['Storytelling', 'Motivation', 'Educational'];
const NARRATORS = ['Storyteller', 'Deep Male', 'Energetic Female'];
const STYLES = ['Cinematic', 'Anime', 'Realistic'];
const ASPECTS = ['9:16 Shorts', '16:9 Widescreen'];

const mono = 'font-mono text-[#22D3EE]';
const label = `${mono} text-xs tracking-[1.5px]`;

const roleOf = (sender) => {
    if (sender === 'You' || sender === 'Sir') return 'Sir';
    if (sender === 'System') return 'System';
    return 'ADA';
};

const clock = (value) => {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const sceneCount = (minutes) => {
    const clamped = Math.max(1, Math.min(10, parseInt(minutes || 1, 10) || 1));
    return Math.max(1, Math.ceil((clamped * 60000 - 400) / 7600));
};

const costCopy = (minutes) => {
    const count = sceneCount(minutes);
    const unit = Number(minutes) === 1 ? 'minute' : 'minutes';
    let text = `Sweety plans ${count} scenes of 8 seconds to reach ${minutes} ${unit}. Each scene is its own Omni video, then the computer stitches narration and captions.`;
    if (Number(minutes) >= 2) text += ' This is a long render and spends many Gemini video calls.';
    return text;
};

const mediaUrl = (name) => `http://127.0.0.1:8000/media/ada/${encodeURIComponent(name)}`;

function TopBar({ title, onBack, extra }) {
    return (
        <div className="flex items-center gap-2 px-[18px] py-3">
            <button type="button" onClick={onBack} aria-label="Back" className="text-[#22D3EE]">
                <ArrowLeft size={24} />
            </button>
            <h1 className={`${mono} text-sm tracking-[2px]`}>{title}</h1>
            <div className="ml-auto">{extra}</div>
        </div>
    );
}

function Chip({ active, children, onClick, disabled }) {
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            className={`rounded-full border px-3 py-1 text-xs ${mono} ${active ? 'border-[#22D3EE] bg-[#22D3EE] text-[#001316]' : 'border-[#155E75] text-[#22D3EE]'} disabled:opacity-40`}
        >
            {children}
        </button>
    );
}

function Tile({ icon, label: text, onClick, hot }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`flex flex-1 flex-col items-center gap-1 rounded-xl px-2 py-2 ${hot ? 'bg-[#3A1020]' : 'bg-[#071016]'}`}
        >
            <span className={hot ? 'text-[#FB7185]' : 'text-[#22D3EE]'}>{icon}</span>
            <span className={`${mono} text-xs tracking-[1px] ${hot ? 'text-[#FB7185]' : 'text-[#22D3EE]'}`}>{text}</span>
        </button>
    );
}

export default function MobileShell({
    socket,
    status,
    messages,
    onSend,
    isLive,
    audioBytes,
    micLevel = 0,
    onToggleSession,
    onInterrupt,
    kasaDevices = [],
    onOpenCad,
    onOpenPrinters,
    onOpenWeb,
    onOpenLegacyStudio,
    onClearTranscript,
    deviceProps,
}) {
    const [screen, setScreen] = useState('home');
    const [look, setLook] = useState(() => normalizeLook(localStorage.getItem('ada-assistant-look')));
    const [keys, setKeys] = useState({ keys: [], cooldown_seconds: 90, keyring: true, count: 0 });
    const [keyDraft, setKeyDraft] = useState('');
    const [keyError, setKeyError] = useState('');
    const [voice, setVoice] = useState('Kore');
    const [liveModel, setLiveModel] = useState('gemini-3.8-live');
    const [textModel, setTextModel] = useState('gemini-3.8-flash');
    const [searchOn, setSearchOn] = useState(true);
    const [personality, setPersonality] = useState('');
    const [notes, setNotes] = useState([]);
    const [draft, setDraft] = useState('');
    const [sharing, setSharing] = useState(false);
    const [shareNote, setShareNote] = useState('');
    const [sessionError, setSessionError] = useState('');
    const [speakingLevel, setSpeakingLevel] = useState(0);
    const [films, setFilms] = useState({ phase: 'Idle', status: 'idle', percent: 0, history: [], running: false });
    const [content, setContent] = useState({
        niche: 'Storytelling', customNiche: '', narrator: 'Storyteller', style: 'Cinematic',
        aspect: '9:16 Shorts', minutes: '1', topic: '',
    });
    const [preview, setPreview] = useState('');
    const [sweetyLog, setSweetyLog] = useState([]);
    const [sweetyText, setSweetyText] = useState('');
    const [sweetyAspect, setSweetyAspect] = useState('9:16');
    const [script, setScript] = useState('');
    const [scriptForm, setScriptForm] = useState({ topic: '', niche: 'tech', tone: 'witty', style: 'cinematic', length: '60' });
    const [scenePrompt, setScenePrompt] = useState('A lantern boat crossing black water, slow push-in.');
    const [sceneAspect, setSceneAspect] = useState('9:16');
    const [sceneNote, setSceneNote] = useState('');
    const shareRef = useRef(null);
    const cameraRef = useRef(null);
    const cameraStream = useRef(null);
    const [cameraOn, setCameraOn] = useState(false);
    const [flipped, setFlipped] = useState(false);
    const [liveFrames, setLiveFrames] = useState(true);

    useEffect(() => {
        const onKeys = (payload) => {
            setKeys(payload || { keys: [], count: 0 });
            if (payload?.error) setKeyError(payload.error);
        };
        const onSettings = (payload) => {
            if (!payload) return;
            if (payload.voice_name) setVoice(payload.voice_name);
            if (payload.live_model) setLiveModel(payload.live_model);
            if (payload.text_model) setTextModel(payload.text_model);
            if (typeof payload.google_search !== 'undefined') setSearchOn(Boolean(payload.google_search));
            if (payload.ada_personality) setPersonality(payload.ada_personality);
            if (payload.assistant_look) {
                const next = normalizeLook(payload.assistant_look);
                setLook(next);
                localStorage.setItem('ada-assistant-look', next);
            }
        };
        const onMemories = (payload) => setNotes(Array.isArray(payload) ? payload : []);
        const onFilm = (payload) => {
            if (!payload) return;
            setFilms(payload);
            const latest = payload.history?.[0];
            if (payload.phase === 'Ready' && latest?.name) setPreview(mediaUrl(latest.name));
        };
        const onSweety = (payload) => {
            if (payload?.text) setSweetyLog((prev) => [...prev, { role: 'Sweety', text: payload.text }].slice(-8));
        };
        const onScript = (payload) => setScript(payload?.text || '');
        const onScene = (payload) => {
            if (payload?.error) setSceneNote(payload.error);
            if (payload?.prompt) {
                setScenePrompt(payload.prompt);
                setScreen('scene');
            }
        };
        const onOpenContent = (payload) => {
            if (payload?.form) {
                setContent((prev) => ({
                    ...prev,
                    niche: payload.form.niche || prev.niche,
                    customNiche: payload.form.custom_niche || '',
                    narrator: payload.form.narrator || prev.narrator,
                    style: payload.form.style || prev.style,
                    aspect: payload.form.aspect || prev.aspect,
                    minutes: String(payload.form.minutes || prev.minutes),
                    topic: payload.form.topic || prev.topic,
                }));
            }
            setScreen('content');
        };
        const onShare = () => startShare();
        const onPlayback = (payload) => setSpeakingLevel(Math.max(0, Math.min(1, Number(payload?.level) || 0)));
        socket.on('gemini_keys', onKeys);
        socket.on('settings', onSettings);
        socket.on('memories', onMemories);
        socket.on('film_status', onFilm);
        socket.on('sweety_line', onSweety);
        socket.on('script_draft', onScript);
        socket.on('scene_status', onScene);
        socket.on('open_scene', onScene);
        socket.on('open_content', onOpenContent);
        socket.on('screen_share_request', onShare);
        const onError = (payload) => setSessionError(payload?.msg || '');
        socket.on('playback_level', onPlayback);
        socket.on('error', onError);
        socket.emit('get_gemini_keys');
        socket.emit('get_settings');
        socket.emit('get_memories');
        socket.emit('get_films');
        return () => {
            socket.off('gemini_keys', onKeys);
            socket.off('settings', onSettings);
            socket.off('memories', onMemories);
            socket.off('film_status', onFilm);
            socket.off('sweety_line', onSweety);
            socket.off('script_draft', onScript);
            socket.off('scene_status', onScene);
            socket.off('open_scene', onScene);
            socket.off('open_content', onOpenContent);
            socket.off('screen_share_request', onShare);
            socket.off('playback_level', onPlayback);
            socket.off('error', onError);
        };
    }, [socket]);

    const hasKey = (keys.count || 0) > 0;
    const activeKey = (keys.keys || []).find((row) => row.state === 'ready');
    const loweredStatus = String(status || '').toLowerCase();
    const speaking = speakingLevel > 0;
    const faceState = sessionError
        ? 'error'
        : speaking
            ? 'speaking'
            : !isLive
                ? 'idle'
                : loweredStatus.includes('connecting')
                    ? 'thinking'
                    : 'listening';
    const orbLevel = speaking ? speakingLevel : faceState === 'listening' ? Math.min(1, (micLevel || 0) / 80) : 0;

    const caption = !hasKey
        ? 'Add a Gemini key to wake ADA'
        : speaking
            ? (look === 'orb' ? 'Speaking  ·  tap the orb to stop' : 'Speaking  ·  tap Sweety to stop')
            : isLive
                ? (look === 'orb' ? 'Listening, Sir  ·  tap the orb to stop' : 'Listening, Sir  ·  tap Sweety to stop')
                : (look === 'orb' ? 'Tap the orb to speak' : 'Tap Sweety to speak');

    const lines = useMemo(() => (messages || []).map((message, index) => ({
        id: index,
        role: roleOf(message.sender),
        text: message.text,
        time: clock(message.time),
    })), [messages]);

    const wake = () => {
        if (!hasKey) {
            setScreen('settings');
            return;
        }
        onToggleSession?.();
    };

    const stopCamera = () => {
        cameraStream.current?.getTracks().forEach((track) => track.stop());
        cameraStream.current = null;
        setCameraOn(false);
    };

    const stopShare = () => {
        shareRef.current?.getTracks().forEach((track) => track.stop());
        shareRef.current = null;
        setSharing(false);
        setShareNote('');
    };

    const startShare = async () => {
        if (sharing) {
            stopShare();
            return;
        }
        stopCamera();
        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
            shareRef.current = stream;
            setSharing(true);
            setShareNote('Looking at your screen, Sir.');
            stream.getVideoTracks()[0].addEventListener('ended', stopShare);
            const video = document.createElement('video');
            video.srcObject = stream;
            await video.play();
            const canvas = document.createElement('canvas');
            const tick = () => {
                if (!shareRef.current) return;
                const scale = 640 / Math.max(video.videoWidth || 640, 1);
                canvas.width = 640;
                canvas.height = Math.max(1, Math.round((video.videoHeight || 360) * scale));
                canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                socket.emit('video_frame', { image: canvas.toDataURL('image/jpeg', 0.55) });
                window.setTimeout(tick, 1000);
            };
            tick();
        } catch (error) {
            setShareNote(error?.name === 'NotAllowedError' ? 'Screen sharing was denied.' : 'Screen sharing was revoked.');
            setSharing(false);
        }
    };

    const openCamera = async () => {
        if (sharing) stopShare();
        setScreen('camera');
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: flipped ? 'user' : 'environment' }, audio: false });
            cameraStream.current = stream;
            if (cameraRef.current) cameraRef.current.srcObject = stream;
            setCameraOn(true);
        } catch (error) {
            setSessionError(error?.message || 'Camera permission was denied.');
        }
    };

    useEffect(() => {
        if (screen !== 'camera') stopCamera();
    }, [screen]);

    useEffect(() => {
        if (!cameraOn || !liveFrames || !isLive || sharing) return undefined;
        const timer = setInterval(() => {
            const video = cameraRef.current;
            if (!video) return;
            const canvas = document.createElement('canvas');
            const scale = 640 / Math.max(video.videoWidth || 640, 1);
            canvas.width = 640;
            canvas.height = Math.max(1, Math.round((video.videoHeight || 360) * scale));
            canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
            socket.emit('video_frame', { image: canvas.toDataURL('image/jpeg', 0.55) });
        }, 1000);
        return () => clearInterval(timer);
    }, [cameraOn, liveFrames, isLive, sharing, socket]);

    const sendPhoto = () => {
        const video = cameraRef.current;
        if (!video) return;
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 480;
        canvas.getContext('2d').drawImage(video, 0, 0);
        socket.emit('video_frame', { image: canvas.toDataURL('image/jpeg', 0.7) });
        onSend?.('Sir sent a photo.');
        stopCamera();
        setScreen('home');
    };

    const saveLook = (next) => {
        const normalized = normalizeLook(next);
        setLook(normalized);
        localStorage.setItem('ada-assistant-look', normalized);
        socket.emit('update_settings', { assistant_look: normalized });
    };

    const page = (title, body, extra) => (
        <div className="flex h-full min-h-0 flex-col bg-black font-sans text-[#E6FBFF]">
            <TopBar title={title} onBack={() => setScreen('home')} extra={extra} />
            <div className="min-h-0 flex-1 overflow-y-auto px-[18px] pb-8">{body}</div>
        </div>
    );

    if (screen === 'transcript') {
        return page('TRANSCRIPT', (
            lines.length === 0
                ? <p className="px-[18px] text-[#8FB8C0]">Nothing said yet, Sir.</p>
                : <div className="space-y-2.5">
                    {lines.map((line) => (
                        <div key={line.id}>
                            <div className={label}>{line.role} · {line.time}</div>
                            <p className="text-base">{line.text}</p>
                        </div>
                    ))}
                </div>
        ), <button type="button" className="text-sm text-[#22D3EE]" onClick={onClearTranscript}>Clear</button>);
    }

    if (screen === 'settings') {
        return page('SETTINGS', (
            <div className="space-y-4">
                <p className="text-sm text-[#8FB8C0]">Keys stay in the OS keychain. ADA never ships with a key inside the app.</p>
                {!keys.keyring && <p className="rounded-xl bg-[#2A1218] p-3 text-sm text-[#FB7185]">OS keychain is unavailable, so keys are in a private file on this computer. Install the Python keyring package to use the OS keychain.</p>}
                <h2 className={label}>GEMINI API KEYS</h2>
                {(keys.keys || []).length === 0 && <p className="text-sm text-[#8FB8C0]">No keys yet. Add the primary key, then any fallbacks.</p>}
                {(keys.keys || []).map((row) => (
                    <div key={row.slot} className="flex items-center justify-between rounded-xl bg-[#071016] px-3 py-2">
                        <div>
                            <div className="text-sm">Key {row.slot} {row.masked}</div>
                            <div className="text-xs text-[#8FB8C0]">{row.detail}{row.source === 'env' ? ' · from .env' : ''}</div>
                        </div>
                        {row.deletable && (
                            <button type="button" aria-label={`Delete key ${row.slot}`} onClick={() => socket.emit('delete_gemini_key', { slot: row.slot })} className="text-[#22D3EE]">
                                <Trash2 size={18} />
                            </button>
                        )}
                    </div>
                ))}
                <input type="password" value={keyDraft} onChange={(event) => setKeyDraft(event.target.value)} placeholder="Add Gemini API key" className="w-full rounded border border-[#155E75] bg-black px-3 py-2 text-sm outline-none" />
                <button type="button" className="text-sm text-[#22D3EE]" onClick={() => { socket.emit('add_gemini_key', { key: keyDraft }); setKeyDraft(''); }}>Save key</button>
                {keyError && <p className="text-sm text-[#FB7185]">{keyError}</p>}
                <p className="text-sm text-[#8FB8C0]">When a key returns 429 or a quota error, ADA cools it for {keys.cooldown_seconds || 90} seconds and uses the next one. Same idea as GEMINI_API_KEY_FALLBACKS on the desktop.</p>
                <h2 className={label}>ASSISTANT LOOK</h2>
                <div className="flex flex-wrap gap-2">
                    <Chip active={look === 'sweety'} onClick={() => saveLook('sweety')}>Sweety face</Chip>
                    <Chip active={look === 'orb'} onClick={() => saveLook('orb')}>Orb</Chip>
                </div>
                <p className="text-sm text-[#8FB8C0]">Sweety is the holographic face on Home: a stylized woman in her twenties, warm and non-sexualized. Orb is the original cyan ring.</p>
                <h2 className={label}>VOICE</h2>
                <div className="flex flex-wrap gap-2">
                    {VOICES.map((name) => <Chip key={name} active={voice === name} onClick={() => { setVoice(name); socket.emit('update_settings', { voice_name: name }); }}>{name}</Chip>)}
                </div>
                <p className="text-sm text-[#8FB8C0]">The live session uses the voice the next time you tap the orb.</p>
                <h2 className={label}>PERSONALITY</h2>
                <textarea value={personality} onChange={(event) => setPersonality(event.target.value)} className="h-[180px] w-full rounded border border-[#155E75] bg-black p-3 text-sm outline-none" />
                <div className="flex gap-4">
                    <button type="button" className="text-sm text-[#22D3EE]" onClick={() => socket.emit('update_settings', { ada_personality: personality })}>Save prompt</button>
                    <button type="button" className="text-sm text-[#22D3EE]" onClick={() => socket.emit('update_settings', { ada_personality: '__reset__' })}>Reset</button>
                </div>
                <div className="flex items-center justify-between">
                    <span>Ground answers when the model allows it</span>
                    <button type="button" aria-label="Google Search" onClick={() => { setSearchOn(!searchOn); socket.emit('update_settings', { google_search: !searchOn }); }} className={`h-6 w-11 rounded-full ${searchOn ? 'bg-[#22D3EE]' : 'bg-[#102027]'}`}>
                        <span className={`block h-5 w-5 rounded-full bg-white transition ${searchOn ? 'translate-x-5' : 'translate-x-0.5'}`} />
                    </button>
                </div>
                <h2 className={label}>MODELS</h2>
                <input value={liveModel} onChange={(event) => setLiveModel(event.target.value)} className="w-full rounded border border-[#155E75] bg-black px-3 py-2 text-sm" />
                <input value={textModel} onChange={(event) => setTextModel(event.target.value)} className="mt-2 w-full rounded border border-[#155E75] bg-black px-3 py-2 text-sm" />
                <button type="button" className="text-sm text-[#22D3EE]" onClick={() => socket.emit('update_settings', { live_model: liveModel, text_model: textModel })}>Save models</button>
                <p className="text-sm text-[#8FB8C0]">Live default is gemini-3.8-live. ADA reads models.list and tries the next voice, video, or speech model if Gemini rejects an id.</p>
                <h2 className={label}>CONNECTIONS</h2>
                {deviceProps && <SettingsWindow socket={socket} embedded {...deviceProps} onClose={() => setScreen('home')} />}
            </div>
        ));
    }

    if (screen === 'memory') {
        return page('MEMORY', (
            <div className="space-y-3">
                <p className="text-sm text-[#8FB8C0]">Notes ADA saves with save_memory. They stay on this computer and are added to her prompt.</p>
                {notes.length === 0 && <p className="text-sm text-[#8FB8C0]">No memories yet. Ask ADA to remember something.</p>}
                {notes.map((note) => (
                    <div key={note.id} className="flex gap-3">
                        <div className="flex-1">
                            <div className={label}>{note.title}</div>
                            <p className="text-sm">{note.body}</p>
                        </div>
                        <button type="button" aria-label={`Delete ${note.title}`} onClick={() => socket.emit('delete_memory_note', { id: note.id })} className="text-[#22D3EE]"><Trash2 size={18} /></button>
                    </div>
                ))}
            </div>
        ));
    }

    if (screen === 'kasa') {
        return page('KASA', (
            <div className="space-y-3">
                <p className="text-sm text-[#8FB8C0]">Legacy TP-Link local control on UDP and TCP port 9999. The computer and the plugs must share a LAN. KLAP-only hardware will not answer.</p>
                <button type="button" onClick={() => socket.emit('discover_kasa')} className="rounded-full bg-[#22D3EE] px-4 py-2 text-sm font-medium text-[#001316]">Scan the network</button>
                {kasaDevices.length === 0 && <p className="text-sm text-[#8FB8C0]">No saved devices. Scan, or ask ADA to list Kasa devices.</p>}
                {kasaDevices.map((device) => (
                    <div key={device.ip} className="flex items-center justify-between">
                        <div>
                            <div className={label}>{device.alias || 'Kasa'}</div>
                            <div className="text-sm text-[#8FB8C0]">{device.ip} {device.model}</div>
                        </div>
                        <button type="button" aria-label={`${device.alias || 'Kasa'} power`} onClick={() => socket.emit('control_kasa', { ip: device.ip, action: device.is_on ? 'off' : 'on' })} className={`h-6 w-11 rounded-full ${device.is_on ? 'bg-[#22D3EE]' : 'bg-[#102027]'}`}>
                            <span className={`block h-5 w-5 rounded-full bg-white ${device.is_on ? 'translate-x-5' : 'translate-x-0.5'}`} />
                        </button>
                    </div>
                ))}
            </div>
        ));
    }

    if (screen === 'camera') {
        return page('CAMERA', (
            <div>
                <h2 className={`${mono} mb-2 text-sm tracking-[2px]`}>VISION</h2>
                <video ref={cameraRef} autoPlay muted playsInline className="aspect-[3/4] w-full rounded-2xl bg-[#071016] object-cover" style={{ transform: flipped ? 'scaleX(-1)' : 'none' }} />
                <p className="mt-3 text-sm text-[#8FB8C0]">Point the camera at what Sir wants ADA to see.</p>
                <p className="text-sm text-[#8FB8C0]">Preview only. Send a still, or share the live feed.</p>
                <div className="mt-3 flex items-center justify-between">
                    <span>Share live frames</span>
                    <button type="button" onClick={() => setLiveFrames(!liveFrames)} className={`h-6 w-11 rounded-full ${liveFrames ? 'bg-[#22D3EE]' : 'bg-[#102027]'}`}>
                        <span className={`block h-5 w-5 rounded-full bg-white ${liveFrames ? 'translate-x-5' : 'translate-x-0.5'}`} />
                    </button>
                </div>
                <div className="mt-4 flex gap-2">
                    <button type="button" onClick={sendPhoto} className="rounded-full bg-[#22D3EE] px-4 py-2 text-sm text-[#001316]">Send photo</button>
                    <button type="button" onClick={() => setFlipped(!flipped)} className="rounded-full bg-[#22D3EE] px-4 py-2 text-sm text-[#001316]">Flip</button>
                </div>
            </div>
        ));
    }

    if (screen === 'studio') {
        return page('STUDIO', (
            <div className="space-y-3">
                <h2 className={label}>SWEETY</h2>
                <p className="text-sm text-[#8FB8C0]">Sweety is the video director inside ADA. She calls you honey, plans the scenes, and Make it renders them one at a time, narrates with Gemini TTS, and stitches one MP4 into Movies/ADA.</p>
                <div className="h-[180px] overflow-y-auto rounded-2xl bg-[#071016] p-3 text-sm text-[#22D3EE]">
                    {sweetyLog.length === 0 && <p>Hey honey, I'm Sweety. Tell me the video you want. When you say make it, I'll shoot the scenes.</p>}
                    {sweetyLog.map((line, index) => <p key={index} className="mt-1">{line.role} {line.text}</p>)}
                </div>
                <textarea value={sweetyText} onChange={(event) => setSweetyText(event.target.value)} placeholder="Talk to Sweety" className="w-full rounded border border-[#155E75] bg-black p-2 text-sm" />
                <div className="flex gap-3">
                    <button type="button" className="rounded-full bg-[#22D3EE] px-4 py-1 text-sm text-[#001316]" onClick={() => {
                        if (!sweetyText.trim()) {
                            setSweetyLog((prev) => [...prev, { role: 'Sweety', text: 'Say something to Sweety first.' }]);
                            return;
                        }
                        setSweetyLog((prev) => [...prev, { role: 'You', text: sweetyText }].slice(-8));
                        socket.emit('sweety_say', { text: sweetyText });
                        setSweetyText('');
                    }}>Send</button>
                    <button type="button" className="text-sm text-[#22D3EE]" onClick={() => socket.emit('sweety_say', { text: sweetyText || 'make it', make: true })}>Make it</button>
                </div>
                <h2 className={label}>ASPECT</h2>
                <div className="flex gap-2">
                    <Chip active={sweetyAspect === '9:16'} onClick={() => setSweetyAspect('9:16')}>9:16</Chip>
                    <Chip active={sweetyAspect === '16:9'} onClick={() => setSweetyAspect('16:9')}>16:9</Chip>
                </div>
                <p className="text-sm text-[#8FB8C0]">Crossfade on · Captions on · Voiceover on</p>
                <h2 className={label}>NARRATION VOICE · gemini-3.8-flash-tts</h2>
                <div className="flex flex-wrap gap-2">{NARRATION.map((name) => <Chip key={name} active={name === 'Sulafat'}>{name}</Chip>)}</div>
                <h2 className={label}>SCRIPT DRAFT</h2>
                <input value={scriptForm.topic} onChange={(event) => setScriptForm({ ...scriptForm, topic: event.target.value })} placeholder="Topic" className="w-full rounded border border-[#155E75] bg-black px-3 py-2 text-sm" />
                <button type="button" className="text-sm text-[#22D3EE]" onClick={() => socket.emit('write_script', scriptForm)}>Write the script</button>
                <div className="flex gap-4">
                    <button type="button" className="text-sm text-[#22D3EE]" onClick={() => setScreen('content')}>Content Video Studio</button>
                    <button type="button" className="text-sm text-[#22D3EE]" onClick={() => setScreen('scene')}>Scene video</button>
                </div>
                {script && <pre className="whitespace-pre-wrap text-sm text-[#E6FBFF]">{script}</pre>}
                {films.status && films.phase !== 'Idle' && <p className="text-sm text-[#22D3EE]">{films.status}</p>}
            </div>
        ));
    }

    if (screen === 'scene') {
        return page('SCENE VIDEO', (
            <div className="space-y-3">
                <p className="text-sm text-[#8FB8C0]">Google Flow has no public API. Veo preview models on the Gemini API shut down on 22 October 2026, so ADA renders with Gemini Omni Flash on the key already saved in Settings. The MP4 is saved to Movies/ADA.</p>
                <textarea value={scenePrompt} onChange={(event) => setScenePrompt(event.target.value)} className="min-h-[88px] w-full rounded border border-[#155E75] bg-black p-3 text-sm" />
                <div className="flex gap-2">
                    <Chip active={sceneAspect === '9:16'} onClick={() => setSceneAspect('9:16')}>9:16 short</Chip>
                    <Chip active={sceneAspect === '16:9'} onClick={() => setSceneAspect('16:9')}>16:9 wide</Chip>
                </div>
                <p className="text-sm text-[#8FB8C0]">Omni Flash · gemini-omni-1.1-flash. If Gemini rejects that id, ADA tries the next video model from models.list.</p>
                <button type="button" onClick={() => {
                    if (scenePrompt.trim().length < 12) {
                        setSceneNote('Describe the scene in a sentence, Sir.');
                        return;
                    }
                    setSceneNote('');
                    socket.emit('render_scene', { prompt: scenePrompt, aspect: sceneAspect });
                }} className="rounded-full bg-[#22D3EE] px-4 py-2 text-sm text-[#001316]">{films.running ? 'Rendering…' : 'Render scene'}</button>
                {sceneNote && <p className="text-sm text-[#FB7185]">{sceneNote}</p>}
                {films.running && <div className="h-1.5 overflow-hidden rounded bg-[#0F172A]"><div className="h-full bg-[#22D3EE]" style={{ width: `${Math.max(films.percent, 5)}%` }} /></div>}
                <p className="text-sm text-[#22D3EE]">{films.status}</p>
                {preview && <video src={preview} controls className="w-full rounded-xl" />}
            </div>
        ));
    }

    if (screen === 'content') {
        const minutes = String(content.minutes || '1').replace(/\D/g, '').slice(0, 2) || '1';
        const warning = costCopy(Math.max(1, Math.min(10, parseInt(minutes, 10) || 1)));
        const busy = Boolean(films.running);
        return (
            <div className="h-full overflow-y-auto bg-[#0A0F1D] font-sans text-[#E2E8F0]">
                <TopBar title="CONTENT VIDEO STUDIO" onBack={() => setScreen('home')} />
                <div className="grid gap-3 p-3 lg:grid-cols-[minmax(280px,1fr)_minmax(320px,2fr)]">
                    <section className="rounded-2xl border border-[#1E293B] bg-[#111827] p-3.5">
                        <h2 className="text-[13px] font-bold tracking-[1px]">CONTENT VIDEO STUDIO</h2>
                        <p className="mt-2 text-xs text-[#94A3B8]">Sweety plans the scenes. Gemini Omni renders each one, then the computer stitches narration and captions.</p>
                        {['Niche', 'Narrator', 'Video style', 'Aspect'].map((name) => {
                            const options = name === 'Niche' ? NICHES : name === 'Narrator' ? NARRATORS : name === 'Video style' ? STYLES : ASPECTS;
                            const key = name === 'Niche' ? 'niche' : name === 'Narrator' ? 'narrator' : name === 'Video style' ? 'style' : 'aspect';
                            return (
                                <label key={name} className="mt-3 block text-[10px] font-bold uppercase tracking-[1px] text-[#94A3B8]">
                                    {name}
                                    <select disabled={busy} value={content[key]} onChange={(event) => setContent({ ...content, [key]: event.target.value, ...(key === 'niche' ? { customNiche: '' } : {}) })} className="mt-1 w-full rounded-lg border border-[#1E293B] bg-[#030712] px-3 py-2 text-sm normal-case tracking-normal text-[#E2E8F0]">
                                        {options.map((option) => <option key={option}>{option}</option>)}
                                    </select>
                                </label>
                            );
                        })}
                        <label className="mt-3 block text-[10px] font-bold uppercase tracking-[1px] text-[#94A3B8]">
                            Finished video duration (minutes)
                            <input disabled={busy} value={content.minutes} onChange={(event) => setContent({ ...content, minutes: event.target.value.replace(/\D/g, '').slice(0, 2) })} className="mt-1 w-full rounded-lg border border-[#1E293B] bg-[#030712] px-3 py-2 text-sm normal-case text-[#E2E8F0]" />
                        </label>
                        <label className="mt-3 block text-[10px] font-bold uppercase tracking-[1px] text-[#94A3B8]">
                            Topic or idea
                            <input disabled={busy} value={content.topic} maxLength={500} onChange={(event) => setContent({ ...content, topic: event.target.value })} className="mt-1 w-full rounded-lg border border-[#1E293B] bg-[#030712] px-3 py-2 text-sm normal-case text-[#E2E8F0]" />
                        </label>
                        <p className="mt-3 text-sm text-[#FBBF24]">{warning}</p>
                        <button type="button" disabled={busy} onClick={() => socket.emit('start_film', { ...content, minutes: Math.max(1, Math.min(10, parseInt(minutes, 10) || 1)) })} className="mt-3 w-full rounded-[10px] bg-gradient-to-r from-[#0891B2] to-[#2563EB] py-3 text-xs font-bold uppercase tracking-[1px] text-white disabled:bg-[#1E293B] disabled:bg-none disabled:text-[#64748B]">
                            {busy ? 'Rendering video pack...' : 'Generate finished video'}
                        </button>
                        <button type="button" disabled={!busy} onClick={() => socket.emit('cancel_film')} className="mt-2 w-full rounded-[10px] bg-[#1E293B] py-3 text-xs font-bold uppercase tracking-[1px] text-[#94A3B8] disabled:bg-[#0F172A] disabled:text-[#475569]">Cancel</button>
                        <div className="mt-3 rounded-[10px] border border-[#1E293B] bg-[#030712] p-2.5 text-xs">
                            <div className="flex justify-between"><span>STATUS</span><span className={films.phase === 'Error' ? 'text-[#FB7185]' : busy ? 'text-[#22D3EE]' : 'text-[#94A3B8]'}>{films.status || 'idle'}</span></div>
                            {films.percent > 0 && <div className="mt-2 h-1.5 rounded bg-[#0F172A]"><div className="h-full bg-[#22D3EE]" style={{ width: `${films.percent}%` }} /></div>}
                        </div>
                    </section>
                    <div className="space-y-3">
                        <section className="rounded-2xl border border-[#1E293B] bg-[#111827] p-3.5">
                            <h3 className="text-[10px] font-bold uppercase tracking-[1px] text-[#94A3B8]">Preview</h3>
                            {preview ? <video src={preview} controls className="mt-3 w-full rounded-xl" /> : <p className="py-16 text-center text-sm text-[#94A3B8]">The finished video plays here.</p>}
                        </section>
                        <section className="rounded-2xl border border-[#1E293B] bg-[#111827] p-3.5">
                            <h3 className="text-[10px] font-bold uppercase tracking-[1px] text-[#94A3B8]">History</h3>
                            {(films.history || []).length === 0 && <p className="mt-3 text-sm text-[#94A3B8]">No finished videos yet.</p>}
                            {(films.history || []).map((row) => (
                                <div key={row.id} className="mt-3 flex items-center gap-3 rounded-[10px] bg-[#030712] p-2">
                                    <div className="flex h-16 w-16 items-center justify-center rounded-lg bg-[#0F172A] text-[#22D3EE]">{(row.style || 'A').slice(0, 1)}</div>
                                    <div className="min-w-0 flex-1">
                                        <p className="line-clamp-2 text-xs">{row.prompt}</p>
                                        <p className="text-[11px] text-[#94A3B8]">{row.style} · {row.aspect} · {Math.round((row.duration_seconds || 0) / 60)} min</p>
                                    </div>
                                    <button type="button" aria-label="Play" onClick={() => setPreview(mediaUrl(row.name))} className="text-[#22D3EE]">▶</button>
                                    <button type="button" aria-label="Delete" onClick={() => socket.emit('delete_film', { id: row.id })} className="text-[#FB7185]"><Trash2 size={16} /></button>
                                </div>
                            ))}
                        </section>
                    </div>
                </div>
            </div>
        );
    }

    if (screen === 'desk') {
        return page('DESK', (
            <div className="space-y-3">
                <p className="text-sm text-[#8FB8C0]">Desktop tools stay here. Ask ADA, or open a panel.</p>
                <button type="button" onClick={onOpenCad} className="flex w-full items-center gap-2 rounded-xl bg-[#071016] px-3 py-3 text-left"><Cpu size={18} className="text-[#22D3EE]" /> CAD</button>
                <button type="button" onClick={onOpenPrinters} className="flex w-full items-center gap-2 rounded-xl bg-[#071016] px-3 py-3 text-left"><Printer size={18} className="text-[#22D3EE]" /> Printers</button>
                <button type="button" onClick={onOpenWeb} className="flex w-full items-center gap-2 rounded-xl bg-[#071016] px-3 py-3 text-left"><Globe size={18} className="text-[#22D3EE]" /> Web agent</button>
                <button type="button" onClick={onOpenLegacyStudio} className="flex w-full items-center gap-2 rounded-xl bg-[#071016] px-3 py-3 text-left"><Video size={18} className="text-[#22D3EE]" /> Runway, InVideo, and Canva</button>
                <button type="button" onClick={() => setScreen('settings')} className="flex w-full items-center gap-2 rounded-xl bg-[#071016] px-3 py-3 text-left"><Settings size={18} className="text-[#22D3EE]" /> Account connections</button>
                <p className="text-sm text-[#8FB8C0]">Facebook, Instagram, TikTok, and YouTube posting still run when Sir asks ADA. Connect the accounts in Settings.</p>
            </div>
        ));
    }

    const peek = lines.slice(-3);
    return (
        <div className="mx-auto flex h-full min-h-0 w-full max-w-[440px] flex-col bg-black px-[18px] font-sans text-[#E6FBFF]">
            <header className="flex items-start justify-between pt-4" style={{ WebkitAppRegion: 'drag' }}>
                <div>
                    <div className="font-mono text-[28px] tracking-[6px] text-[#E6FBFF]">A.D.A</div>
                    <div className={label}>DESKTOP · FOR JEFFREY LLAMAS</div>
                </div>
                <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' }}>
                    {activeKey && <span className={label}>KEY {activeKey.slot}</span>}
                    <button type="button" aria-label="Settings" onClick={() => setScreen('settings')} className="text-[#22D3EE]"><Settings size={22} /></button>
                </div>
            </header>
            {sessionError && (
                <div className="mt-3 flex items-start justify-between rounded-xl bg-[#2A1218] p-3 text-sm text-[#FB7185]">
                    <span>{sessionError}</span>
                    <button type="button" onClick={() => setSessionError('')}>Dismiss</button>
                </div>
            )}
            <div className="flex flex-1 flex-col items-center justify-center">
                <button type="button" onClick={wake} className="rounded-full" aria-label={look === 'orb' ? 'A.D.A orb' : 'Sweety'}>
                    {look === 'orb'
                        ? <OrbMark state={faceState === 'thinking' ? 'connecting' : faceState} level={orbLevel} />
                        : <SweetyFace mood={faceState} playbackLevel={speakingLevel} />}
                </button>
                <p className={`${label} mt-2 text-center`}>{caption}</p>
                {speaking && <button type="button" className="mt-1 text-sm text-[#FB7185]" onClick={onInterrupt}>Interrupt</button>}
            </div>
            <button type="button" onClick={() => setScreen('transcript')} className="w-full rounded-2xl bg-[#071016] p-3.5 text-left">
                <div className={label}>TRANSCRIPT</div>
                {peek.length === 0
                    ? <p className="mt-1.5 text-sm">{look === 'orb'
                        ? 'ADA is standing by, Sir. Tap the orb and speak, or type a message.'
                        : 'ADA is standing by, Sir. Tap Sweety and speak, or type a message.'}</p>
                    : peek.map((line) => <p key={line.id} className="mt-1 line-clamp-2 text-sm">{line.role}  {line.text}</p>)}
            </button>
            <div className="mt-2.5 flex gap-2">
                <Tile icon={<Camera size={22} />} label="Camera" onClick={openCamera} />
                <Tile icon={sharing ? <Square size={22} /> : <MonitorUp size={22} />} label={sharing ? 'Stop share' : 'Share screen'} hot={sharing} onClick={startShare} />
            </div>
            <div className="mt-2 flex gap-2">
                <Tile icon={<Clapperboard size={22} />} label="Studio" onClick={() => setScreen('studio')} />
                <Tile icon={<Library size={22} />} label="Content" onClick={() => setScreen('content')} />
                <Tile icon={<Home size={22} />} label="Kasa" onClick={() => setScreen('kasa')} />
                <Tile icon={<MemoryStick size={22} />} label="Memory" onClick={() => setScreen('memory')} />
            </div>
            <button type="button" onClick={() => setScreen('desk')} className={`${mono} mt-2 text-xs tracking-[1px] text-[#22D3EE]`}>Desk · CAD, printers, web, Runway</button>
            {sharing && <p className="mt-2 text-sm text-[#FB7185]">Watching your screen. Camera frames are paused.</p>}
            <form className="mt-2 flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); onSend?.(draft); setDraft(''); }}>
                <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Type to ADA" className="h-11 flex-1 rounded border border-[#155E75] bg-black px-3 text-sm outline-none" />
                <button type="submit" aria-label="Send" className="text-[#22D3EE]"><Send size={20} /></button>
                <button type="button" aria-label={isLive ? 'Stop' : 'Microphone'} onClick={wake} className={isLive ? 'text-[#FB7185]' : 'text-[#22D3EE]'}>
                    {isLive ? <Square size={18} /> : <Mic size={20} />}
                </button>
            </form>
            <p className="mb-3 mt-1 line-clamp-2 text-sm text-[#8FB8C0]">{status || 'Standing by'}</p>
        </div>
    );
}
