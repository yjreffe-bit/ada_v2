import React, { useMemo, useState } from 'react';
import { Clapperboard, ExternalLink, Play, RefreshCw, Upload, Wand2, X } from 'lucide-react';

const NICHES = ['Storytelling', 'Anime Facts', 'Motivation', 'Finance', 'Tech', 'Business', 'History', 'Luxury'];
const NARRATORS = ['Storyteller', 'Authority', 'Energetic', 'Documentary', 'Calm', 'Bold Hook'];
const STYLES = ['cinematic', 'anime', 'realistic', 'documentary', 'neon'];
const PLATFORMS = ['YouTube', 'TikTok', 'Instagram', 'Facebook'];

const VideoContentWindow = ({ socket, data, status, onClose, mobileLayout = false }) => {
    const [topic, setTopic] = useState(data?.topic || 'Luxury mindset habits that quietly build wealth');
    const [niche, setNiche] = useState(data?.request?.niche || NICHES[0]);
    const [narratorStyle, setNarratorStyle] = useState(data?.request?.narrator_style || NARRATORS[0]);
    const [videoStyle, setVideoStyle] = useState(data?.request?.video_style || STYLES[0]);
    const [aspectRatio, setAspectRatio] = useState(data?.request?.aspect_ratio || '9:16');
    const [durationSeconds, setDurationSeconds] = useState(data?.request?.duration_seconds || 90);
    const [includeIntro, setIncludeIntro] = useState(data?.request?.include_intro ?? true);
    const [includeOutro, setIncludeOutro] = useState(data?.request?.include_outro ?? true);
    const [platformTargets, setPlatformTargets] = useState(data?.request?.platform_targets || PLATFORMS);

    const previewSrc = useMemo(() => {
        if (data?.preview_url) {
            if (/^https?:/i.test(data.preview_url)) {
                return data.preview_url;
            }

            try {
                return new URL(data.preview_url, socket.io.uri).toString();
            } catch {
                return data.preview_url;
            }
        }

        if (!data?.saved_video_path && !data?.video_path) {
            return null;
        }

        const path = data.saved_video_path || data.video_path;
        if (typeof window !== 'undefined' && typeof window.require === 'function') {
            return path;
        }
        return path;
    }, [data]);

    const togglePlatform = (platform) => {
        setPlatformTargets(prev => prev.includes(platform)
            ? prev.filter(item => item !== platform)
            : [...prev, platform]);
    };

    const handleGenerate = () => {
        socket.emit('generate_content_video', {
            topic,
            niche,
            narrator_style: narratorStyle,
            video_style: videoStyle,
            aspect_ratio: aspectRatio,
            duration_seconds: Math.max(90, Number(durationSeconds) || 90),
            include_intro: includeIntro,
            include_outro: includeOutro,
            platform_targets: platformTargets.length > 0 ? platformTargets : PLATFORMS,
        });
    };

    const uploadLinks = data?.upload_links || {};

    return (
        <div className="w-full h-full relative bg-[#08111a] rounded-2xl overflow-hidden border border-cyan-500/20 flex flex-col">
            <div data-drag-handle className="h-10 px-4 bg-[#0d1824] border-b border-cyan-500/20 flex items-center justify-between shrink-0 cursor-grab active:cursor-grabbing">
                <div className="flex items-center gap-2 text-cyan-200 text-xs font-mono tracking-[0.2em] uppercase">
                    <Clapperboard size={14} className="text-cyan-400" />
                    <span>Content Video Studio</span>
                </div>
                <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
                    <X size={16} />
                </button>
            </div>

            <div className={`flex-1 min-h-0 ${mobileLayout ? 'overflow-y-auto' : 'overflow-hidden'} flex ${mobileLayout ? 'flex-col' : 'flex-row'}`}>
                <div className={`${mobileLayout ? 'w-full' : 'w-[22rem]'} shrink-0 border-r border-cyan-500/10 bg-black/30 p-4 space-y-4 overflow-y-auto`}>
                    <div>
                        <label className="block text-[10px] uppercase tracking-[0.2em] text-cyan-500 mb-2">Topic</label>
                        <textarea
                            value={topic}
                            onChange={(e) => setTopic(e.target.value)}
                            rows={3}
                            className="w-full rounded-xl bg-black/50 border border-cyan-500/20 px-3 py-2 text-sm text-cyan-50 outline-none focus:border-cyan-400 resize-none"
                        />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="block text-[10px] uppercase tracking-[0.2em] text-cyan-500 mb-2">Niche</label>
                            <select value={niche} onChange={(e) => setNiche(e.target.value)} className="w-full rounded-xl bg-black/50 border border-cyan-500/20 px-3 py-2 text-sm text-cyan-50 outline-none">
                                {NICHES.map(option => <option key={option} value={option}>{option}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className="block text-[10px] uppercase tracking-[0.2em] text-cyan-500 mb-2">Narrator</label>
                            <select value={narratorStyle} onChange={(e) => setNarratorStyle(e.target.value)} className="w-full rounded-xl bg-black/50 border border-cyan-500/20 px-3 py-2 text-sm text-cyan-50 outline-none">
                                {NARRATORS.map(option => <option key={option} value={option}>{option}</option>)}
                            </select>
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="block text-[10px] uppercase tracking-[0.2em] text-cyan-500 mb-2">Video Style</label>
                            <select value={videoStyle} onChange={(e) => setVideoStyle(e.target.value)} className="w-full rounded-xl bg-black/50 border border-cyan-500/20 px-3 py-2 text-sm text-cyan-50 outline-none">
                                {STYLES.map(option => <option key={option} value={option}>{option}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className="block text-[10px] uppercase tracking-[0.2em] text-cyan-500 mb-2">Aspect</label>
                            <select value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)} className="w-full rounded-xl bg-black/50 border border-cyan-500/20 px-3 py-2 text-sm text-cyan-50 outline-none">
                                <option value="9:16">9:16 Shorts</option>
                                <option value="16:9">16:9 Wide</option>
                            </select>
                        </div>
                    </div>

                    <div>
                        <label className="block text-[10px] uppercase tracking-[0.2em] text-cyan-500 mb-2">Duration</label>
                        <input
                            type="number"
                            min="90"
                            step="15"
                            value={durationSeconds}
                            onChange={(e) => setDurationSeconds(e.target.value)}
                            className="w-full rounded-xl bg-black/50 border border-cyan-500/20 px-3 py-2 text-sm text-cyan-50 outline-none"
                        />
                    </div>

                    <div className="grid grid-cols-2 gap-3 text-sm text-cyan-100">
                        <label className="flex items-center gap-2 rounded-xl border border-cyan-500/10 bg-black/30 px-3 py-2">
                            <input type="checkbox" checked={includeIntro} onChange={(e) => setIncludeIntro(e.target.checked)} />
                            Intro
                        </label>
                        <label className="flex items-center gap-2 rounded-xl border border-cyan-500/10 bg-black/30 px-3 py-2">
                            <input type="checkbox" checked={includeOutro} onChange={(e) => setIncludeOutro(e.target.checked)} />
                            Outro
                        </label>
                    </div>

                    <div>
                        <label className="block text-[10px] uppercase tracking-[0.2em] text-cyan-500 mb-2">Platforms</label>
                        <div className="grid grid-cols-2 gap-2">
                            {PLATFORMS.map(platform => (
                                <button
                                    key={platform}
                                    type="button"
                                    onClick={() => togglePlatform(platform)}
                                    className={`rounded-xl border px-3 py-2 text-xs uppercase tracking-[0.15em] transition-colors ${platformTargets.includes(platform)
                                        ? 'border-cyan-400 bg-cyan-500/10 text-cyan-200'
                                        : 'border-cyan-500/10 bg-black/30 text-cyan-500/70'}`}
                                >
                                    {platform}
                                </button>
                            ))}
                        </div>
                    </div>

                    <button
                        onClick={handleGenerate}
                        className="w-full rounded-2xl border border-cyan-400/40 bg-cyan-500/10 px-4 py-3 text-sm font-semibold text-cyan-100 transition-colors hover:bg-cyan-500/20 inline-flex items-center justify-center gap-2"
                    >
                        {status === 'rendering' || status === 'planning' ? <RefreshCw size={16} className="animate-spin" /> : <Wand2 size={16} />}
                        Generate Video Pack
                    </button>

                    <div className="rounded-2xl border border-cyan-500/10 bg-black/30 p-3 text-xs text-cyan-100/80 space-y-2">
                        <div className="uppercase tracking-[0.2em] text-cyan-500">Status</div>
                        <div>{data?.message || status || 'Ready'}</div>
                        {data?.narration_warning && <div className="text-yellow-300">{data.narration_warning}</div>}
                    </div>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
                    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(22rem,0.9fr)]">
                        <div className="rounded-2xl border border-cyan-500/10 bg-black/30 overflow-hidden min-h-[18rem]">
                            <div className="px-4 py-3 border-b border-cyan-500/10 flex items-center justify-between text-xs uppercase tracking-[0.2em] text-cyan-400">
                                <span>Preview</span>
                                {previewSrc && <span>{Math.round((data?.duration_seconds || 0) / 60)}:{String((data?.duration_seconds || 0) % 60).padStart(2, '0')}</span>}
                            </div>
                            <div className="p-4">
                                {previewSrc ? (
                                    <video src={previewSrc} controls className="w-full rounded-2xl bg-black" />
                                ) : (
                                    <div className="h-[22rem] rounded-2xl border border-dashed border-cyan-500/20 flex flex-col items-center justify-center gap-3 text-cyan-500/60">
                                        <Play size={28} />
                                        <span className="text-xs uppercase tracking-[0.2em]">Preview appears here after render</span>
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="rounded-2xl border border-cyan-500/10 bg-black/30 overflow-hidden">
                            <div className="px-4 py-3 border-b border-cyan-500/10 text-xs uppercase tracking-[0.2em] text-cyan-400">Publishing</div>
                            <div className="p-4 space-y-3">
                                <div>
                                    <div className="text-cyan-100 text-sm font-semibold">{data?.title || 'No title yet'}</div>
                                    <div className="text-cyan-500/70 text-xs mt-1">{data?.thumbnail_text || 'Thumbnail headline will appear here.'}</div>
                                </div>
                                <div className="text-xs text-cyan-100/80 leading-relaxed whitespace-pre-wrap">{data?.description || 'Description and captions will appear once generated.'}</div>
                                {data?.hashtags?.length > 0 && (
                                    <div className="flex flex-wrap gap-2">
                                        {data.hashtags.map(tag => (
                                            <span key={tag} className="rounded-full border border-cyan-500/20 bg-cyan-500/10 px-2 py-1 text-[11px] text-cyan-200">{tag}</span>
                                        ))}
                                    </div>
                                )}
                                <div className="grid grid-cols-2 gap-2">
                                    {Object.entries(uploadLinks).map(([platform, url]) => (
                                        <a
                                            key={platform}
                                            href={url}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="rounded-xl border border-cyan-500/20 bg-black/30 px-3 py-2 text-xs uppercase tracking-[0.15em] text-cyan-200 hover:bg-cyan-500/10 inline-flex items-center justify-between"
                                        >
                                            <span>{platform}</span>
                                            <ExternalLink size={12} />
                                        </a>
                                    ))}
                                </div>
                                {data?.saved_video_path && (
                                    <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-200 break-all">
                                        Saved: {data.saved_video_path}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className="rounded-2xl border border-cyan-500/10 bg-black/30 overflow-hidden">
                        <div className="px-4 py-3 border-b border-cyan-500/10 text-xs uppercase tracking-[0.2em] text-cyan-400">Script Breakdown</div>
                        <div className="p-4 space-y-3">
                            {data?.scenes?.length ? data.scenes.map((scene, index) => (
                                <div key={`${scene.heading}-${index}`} className="rounded-2xl border border-cyan-500/10 bg-black/30 p-3 space-y-2">
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="text-sm font-semibold text-cyan-100">{scene.heading}</div>
                                        <div className="text-[11px] uppercase tracking-[0.15em] text-cyan-500">{scene.duration_seconds}s</div>
                                    </div>
                                    <div className="text-sm text-cyan-50/90 whitespace-pre-wrap">{scene.narration}</div>
                                    <div className="text-xs text-cyan-400/80">On screen: {scene.on_screen_text}</div>
                                    <div className="text-xs text-cyan-500/70">Visuals: {scene.visual_direction}</div>
                                </div>
                            )) : (
                                <div className="text-sm text-cyan-500/70">Generate a video pack to populate the script, visuals, preview, and publishing data.</div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default VideoContentWindow;