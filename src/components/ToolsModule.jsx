import React from 'react';
import { Mic, MicOff, Settings, Power, Video, VideoOff, Hand, Lightbulb, Printer, Globe, Box, Clapperboard } from 'lucide-react';

const ToolsModule = ({
    isConnected,
    isMuted,
    isVideoOn,
    isHandTrackingEnabled,
    showSettings,
    onTogglePower,
    onToggleMute,
    onToggleVideo,
    onToggleSettings,

    onToggleHand,
    onToggleKasa,
    showKasaWindow,
    onTogglePrinter,
    showPrinterWindow,
    onToggleCad,
    showCadWindow,
    onToggleBrowser,
    showBrowserWindow,
    onToggleVideoStudio,
    showVideoStudioWindow,
    activeDragElement,

    position,
    mobileLayout = false,
    onMouseDown
}) => {
    return (
        <div
            id="tools"
            onMouseDown={onMouseDown}
            className={`${mobileLayout ? 'relative w-full max-w-full px-4 py-4 rounded-[28px]' : 'absolute px-6 py-3 rounded-full'} transition-all duration-200 
                        backdrop-blur-xl bg-black/40 border border-white/10 shadow-2xl`}
            style={{
                ...(mobileLayout ? {
                    width: '100%',
                    maxWidth: '640px'
                } : {
                    left: position.x,
                    top: position.y,
                    transform: 'translate(-50%, -50%)'
                }),
                pointerEvents: 'auto'
            }}
        >
            <div className={`absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-5 pointer-events-none mix-blend-overlay ${mobileLayout ? 'rounded-[28px]' : 'rounded-full'}`}></div>

            <div className={`relative z-10 ${mobileLayout ? 'grid grid-cols-3 gap-3 sm:grid-cols-5' : 'flex justify-center gap-6'}`}>
                {/* Power Button */}
                <button
                    onClick={onTogglePower}
                    className={`${mobileLayout ? 'w-full justify-center' : ''} p-3 rounded-full border-2 transition-all duration-300 inline-flex items-center ${isConnected
                        ? 'border-green-500 bg-green-500/10 text-green-500 hover:bg-green-500/20 shadow-[0_0_15px_rgba(34,197,94,0.3)]'
                        : 'border-gray-600 bg-gray-600/10 text-gray-500 hover:bg-gray-600/20'
                        } `}
                >
                    <Power size={24} />
                </button>

                {/* Mute Button */}
                <button
                    onClick={onToggleMute}
                    disabled={!isConnected}
                    className={`${mobileLayout ? 'w-full justify-center' : ''} p-3 rounded-full border-2 transition-all duration-300 inline-flex items-center ${!isConnected
                        ? 'border-gray-800 text-gray-800 cursor-not-allowed'
                        : isMuted
                            ? 'border-red-500 bg-red-500/10 text-red-500 hover:bg-red-500/20 shadow-[0_0_15px_rgba(239,68,68,0.3)]'
                            : 'border-cyan-500 bg-cyan-500/10 text-cyan-500 hover:bg-cyan-500/20 shadow-[0_0_15px_rgba(6,182,212,0.3)]'
                        } `}
                >
                    {isMuted ? <MicOff size={24} /> : <Mic size={24} />}
                </button>

                {/* Video Button */}
                <button
                    onClick={onToggleVideo}
                    className={`${mobileLayout ? 'w-full justify-center' : ''} p-3 rounded-full border-2 transition-all duration-300 inline-flex items-center ${isVideoOn
                        ? 'border-purple-500 bg-purple-500/10 text-purple-500 hover:bg-purple-500/20 shadow-[0_0_15px_rgba(168,85,247,0.3)]'
                        : 'border-cyan-900 text-cyan-700 hover:border-cyan-500 hover:text-cyan-500'
                        } `}
                >
                    {isVideoOn ? <Video size={24} /> : <VideoOff size={24} />}
                </button>

                {/* Settings Button */}
                <button
                    onClick={onToggleSettings}
                    className={`${mobileLayout ? 'w-full justify-center' : ''} p-3 rounded-full border-2 transition-all inline-flex items-center ${showSettings ? 'border-cyan-400 text-cyan-400 bg-cyan-900/20' : 'border-cyan-900 text-cyan-700 hover:border-cyan-500 hover:text-cyan-500'
                        } `}
                >
                    <Settings size={24} />
                </button>

                {/* Hand Tracking Toggle */}
                <button
                    onClick={onToggleHand}
                    className={`${mobileLayout ? 'w-full justify-center' : ''} p-3 rounded-full border-2 transition-all duration-300 inline-flex items-center ${isHandTrackingEnabled
                        ? 'border-orange-500 bg-orange-500/10 text-orange-500 hover:bg-orange-500/20 shadow-[0_0_15px_rgba(249,115,22,0.3)]'
                        : 'border-cyan-900 text-cyan-700 hover:border-cyan-500 hover:text-cyan-500'
                        } `}
                >
                    <Hand size={24} />
                </button>

                {/* Kasa Light Control */}
                <button
                    onClick={onToggleKasa}
                    className={`${mobileLayout ? 'w-full justify-center' : ''} p-3 rounded-full border-2 transition-all duration-300 inline-flex items-center ${showKasaWindow
                        ? 'border-yellow-300 bg-yellow-300/10 text-yellow-300 hover:bg-yellow-300/20 shadow-[0_0_15px_rgba(253,224,71,0.3)]'
                        : 'border-cyan-900 text-cyan-700 hover:border-cyan-500 hover:text-cyan-500'
                        } `}
                >
                    <Lightbulb size={24} />
                </button>

                {/* 3D Printer Control */}
                <button
                    onClick={onTogglePrinter}
                    className={`${mobileLayout ? 'w-full justify-center' : ''} p-3 rounded-full border-2 transition-all duration-300 inline-flex items-center ${showPrinterWindow
                        ? 'border-green-400 bg-green-400/10 text-green-400 hover:bg-green-400/20'
                        : 'border-cyan-900 text-cyan-700 hover:border-green-500 hover:text-green-500'
                        } `}
                >
                    <Printer size={24} />
                </button>

                {/* CAD Agent Toggle */}
                <button
                    onClick={onToggleCad}
                    className={`${mobileLayout ? 'w-full justify-center' : ''} p-3 rounded-full border-2 transition-all duration-300 inline-flex items-center ${showCadWindow
                        ? 'border-cyan-400 bg-cyan-400/10 text-cyan-400 hover:bg-cyan-400/20 shadow-[0_0_15px_rgba(34,211,238,0.3)]'
                        : 'border-cyan-900 text-cyan-700 hover:border-cyan-500 hover:text-cyan-500'
                        } `}
                >
                    <Box size={24} />
                </button>

                {/* Web Agent Toggle */}
                <button
                    onClick={onToggleBrowser}
                    className={`${mobileLayout ? 'w-full justify-center' : ''} p-3 rounded-full border-2 transition-all duration-300 inline-flex items-center ${showBrowserWindow
                        ? 'border-blue-400 bg-blue-400/10 text-blue-400 hover:bg-blue-400/20 shadow-[0_0_15px_rgba(96,165,250,0.3)]'
                        : 'border-cyan-900 text-cyan-700 hover:border-blue-500 hover:text-blue-500'
                        } `}
                >
                    <Globe size={24} />
                </button>

                <button
                    onClick={onToggleVideoStudio}
                    className={`${mobileLayout ? 'w-full justify-center' : ''} p-3 rounded-full border-2 transition-all duration-300 inline-flex items-center ${showVideoStudioWindow
                        ? 'border-pink-400 bg-pink-400/10 text-pink-300 hover:bg-pink-400/20 shadow-[0_0_15px_rgba(244,114,182,0.25)]'
                        : 'border-cyan-900 text-cyan-700 hover:border-pink-400 hover:text-pink-300'
                        } `}
                >
                    <Clapperboard size={24} />
                </button>
            </div>
        </div>
    );
};

export default ToolsModule;
