import React, { Suspense, lazy, useEffect, useMemo, useState, useRef } from 'react';
import io from 'socket.io-client';
import MobileShell from './shell/MobileShell';

import Visualizer from './components/Visualizer';
import TopAudioBar from './components/TopAudioBar';
import ChatModule from './components/ChatModule';
import ToolsModule from './components/ToolsModule';
import { X, Minus, Printer, Clock, RefreshCw, ShieldAlert } from 'lucide-react';

const CadWindow = lazy(() => import('./components/CadWindow'));
const BrowserWindow = lazy(() => import('./components/BrowserWindow'));
const VideoContentWindow = lazy(() => import('./components/VideoContentWindow'));
const ConfirmationPopup = lazy(() => import('./components/ConfirmationPopup'));
const AuthLock = lazy(() => import('./components/AuthLock'));
const KasaWindow = lazy(() => import('./components/KasaWindow'));
const PrinterWindow = lazy(() => import('./components/PrinterWindow'));



const electronApi = typeof window !== 'undefined' && typeof window.require === 'function'
    ? window.require('electron')
    : null;
const ipcRenderer = electronApi?.ipcRenderer ?? null;

const resolveSocketUrl = () => {
    if (typeof window === 'undefined') {
        return 'http://127.0.0.1:8000';
    }

    const configuredUrl = import.meta.env.VITE_SOCKET_URL;
    if (configuredUrl) {
        return configuredUrl;
    }

    if (window.location.protocol === 'file:') {
        return 'http://127.0.0.1:8000';
    }

    return window.location.origin;
};

const socket = io(resolveSocketUrl(), {
    transports: ['websocket', 'polling'],
    autoConnect: true,
    withCredentials: false,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 10000
});

const isLocalBrowserHost = () => {
    if (typeof window === 'undefined') return true;
    return ['localhost', '127.0.0.1'].includes(window.location.hostname);
};

const isExplicitRemoteBrowserMode = () => {
    if (typeof window === 'undefined') return false;

    const params = new URLSearchParams(window.location.search);
    const remoteParam = (params.get('remote') || params.get('remoteAudio') || '').toLowerCase();
    const configuredMode = (import.meta.env.VITE_REMOTE_AUDIO_MODE || '').toLowerCase();

    return ['1', 'true', 'host', 'remote'].includes(remoteParam)
        || ['host', 'remote'].includes(configuredMode);
};

const isSecureMediaContext = () => {
    if (typeof window === 'undefined') return true;
    return window.location.protocol === 'file:' || window.isSecureContext || isLocalBrowserHost();
};

const getMediaErrorMessage = (error, type) => {
    if (!error) {
        return `${type} access is unavailable.`;
    }

    switch (error.name) {
        case 'NotAllowedError':
        case 'PermissionDeniedError':
            return `${type} permission was denied by the browser.`;
        case 'NotFoundError':
        case 'DevicesNotFoundError':
            return `No ${type.toLowerCase()} device was found.`;
        case 'NotReadableError':
        case 'TrackStartError':
            return `${type} is busy in another app or unavailable.`;
        case 'SecurityError':
            return `${type} requires HTTPS or localhost in mobile browsers.`;
        case 'OverconstrainedError':
            return `The selected ${type.toLowerCase()} device is not available.`;
        default:
            return error.message || `${type} could not be started.`;
    }
};

const LoadingPanel = ({ label = 'Loading panel...' }) => (
    <div className="flex h-full min-h-[8rem] w-full items-center justify-center text-xs uppercase tracking-[0.2em] text-cyan-500/70">
        {label}
    </div>
);

const getViewportState = () => {
    if (typeof window === 'undefined') {
        return {
            width: 1280,
            height: 720,
            isMobileLayout: false,
            isCompactLayout: false
        };
    }

    const width = window.innerWidth;
    const height = window.innerHeight;

    return {
        width,
        height,
        isMobileLayout: width <= 1024,
        isCompactLayout: width <= 480 || height <= 760
    };
};

const clampWithinViewport = (pos, size, options = {}) => {
    const { width, height } = getViewportState();
    const {
        margin = 12,
        topOffset = 60,
        bottomOffset = 12
    } = options;

    return {
        x: Math.max(size.w / 2 + margin, Math.min(width - size.w / 2 - margin, pos.x)),
        y: Math.max(size.h / 2 + margin + topOffset, Math.min(height - size.h / 2 - margin - bottomOffset, pos.y))
    };
};

function App() {
    const [status, setStatus] = useState('Disconnected');
    const [socketConnected, setSocketConnected] = useState(socket.connected); // Track socket connection reactively
    // Auth State
    const [isAuthenticated, setIsAuthenticated] = useState(() => {
        // Optimistically assume authenticated if face auth is NOT enabled
        return localStorage.getItem('face_auth_enabled') !== 'true';
    });

    // Initialize from LocalStorage to prevent flash of UI
    const [isLockScreenVisible, setIsLockScreenVisible] = useState(() => {
        const saved = localStorage.getItem('face_auth_enabled');
        // If saved is 'true', we MUST start locked.
        // If 'false' or null (default off), we start unlocked.
        return saved === 'true';
    });

    // Local state for tracking settings, also init from local storage
    const [faceAuthEnabled, setFaceAuthEnabled] = useState(() => {
        return localStorage.getItem('face_auth_enabled') === 'true';
    });


    const [isConnected, setIsConnected] = useState(true); // Power state DEFAULT ON
    const [isMuted, setIsMuted] = useState(true); // Mic state DEFAULT MUTED
    const [isVideoOn, setIsVideoOn] = useState(false); // Video state
    const [messages, setMessages] = useState([]);
    const [inputValue, setInputValue] = useState('');
    const [cadData, setCadData] = useState(null);
    const [cadThoughts, setCadThoughts] = useState(''); // Streaming AI thoughts
    const [cadRetryInfo, setCadRetryInfo] = useState({ attempt: 1, maxAttempts: 3, error: null }); // Retry status
    const [browserData, setBrowserData] = useState({ image: null, logs: [] });
    // showMemoryPrompt removed - memory is now actively saved to project
    const [confirmationRequest, setConfirmationRequest] = useState(null); // { id, tool, args }
    const [kasaDevices, setKasaDevices] = useState([]);
    const [showKasaWindow, setShowKasaWindow] = useState(false);
    const [showPrinterWindow, setShowPrinterWindow] = useState(false);
    const [showCadWindow, setShowCadWindow] = useState(false);
    const [showBrowserWindow, setShowBrowserWindow] = useState(false);
    const [showVideoStudioWindow, setShowVideoStudioWindow] = useState(false);
    const [videoContentData, setVideoContentData] = useState(null);
    const [videoContentStatus, setVideoContentStatus] = useState('idle');
    const [geminiKeyStatus, setGeminiKeyStatus] = useState(null);

    // Printing workflow status (for top toolbar display)
    const [slicingStatus, setSlicingStatus] = useState({ active: false, percent: 0, message: '' });
    const [activePrintStatus, setActivePrintStatus] = useState(null); // {printer, progress_percent, time_elapsed, state}
    const [printerCount, setPrinterCount] = useState(0); // Count of connected printers
    const [currentTime, setCurrentTime] = useState(new Date()); // Live clock


    // RESTORED STATE
    const [aiAudioData, setAiAudioData] = useState(new Array(64).fill(0));
    const [micAudioData, setMicAudioData] = useState(new Array(32).fill(0));
    const [fps, setFps] = useState(0);

    // Device states - microphones, speakers, webcams
    const [micDevices, setMicDevices] = useState([]);
    const [speakerDevices, setSpeakerDevices] = useState([]);
    const [webcamDevices, setWebcamDevices] = useState([]);

    // Selected device IDs - restored from localStorage
    const [selectedMicId, setSelectedMicId] = useState(() => localStorage.getItem('selectedMicId') || '');
    const [selectedSpeakerId, setSelectedSpeakerId] = useState(() => localStorage.getItem('selectedSpeakerId') || '');
    const [selectedWebcamId, setSelectedWebcamId] = useState(() => localStorage.getItem('selectedWebcamId') || '');
    const [showSettings, setShowSettings] = useState(false);
    const [currentProject, setCurrentProject] = useState('default');
    const [viewport, setViewport] = useState(getViewportState);

    const isMobileLayout = viewport.isMobileLayout;
    const isCompactLayout = viewport.isCompactLayout;
    const isElectron = Boolean(ipcRenderer);
    const isRemoteBrowserClient = !isElectron && isExplicitRemoteBrowserMode();
    const secureMediaAvailable = isElectron || isSecureMediaContext();

    const [connectionIssue, setConnectionIssue] = useState('');
    const [mediaWarning, setMediaWarning] = useState('');
    const [isOnline, setIsOnline] = useState(() => typeof navigator === 'undefined' ? true : navigator.onLine);
    const [mediaPermissions, setMediaPermissions] = useState({ audio: false, video: false });

    // Modular Mode State
    const [isModularMode, setIsModularMode] = useState(false);
    const [elementPositions, setElementPositions] = useState({
        video: { x: 40, y: 80 }, // Initial positions (approximate)
        visualizer: { x: window.innerWidth / 2, y: window.innerHeight / 2 - 150 },
        chat: { x: window.innerWidth / 2, y: window.innerHeight / 2 + 100 },
        cad: { x: window.innerWidth / 2 + 300, y: window.innerHeight / 2 },
        browser: { x: window.innerWidth / 2 - 300, y: window.innerHeight / 2 },
        videoContent: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
        kasa: { x: window.innerWidth / 2 + 350, y: window.innerHeight / 2 - 100 },
        printer: { x: window.innerWidth / 2 - 350, y: window.innerHeight / 2 - 100 },
        tools: { x: window.innerWidth / 2, y: window.innerHeight - 100 } // Fixed bottom OFFSET
    });

    const [elementSizes, setElementSizes] = useState({
        visualizer: { w: 550, h: 350 },
        chat: { w: 550, h: 220 },
        tools: { w: 500, h: 80 }, // Approx
        cad: { w: 400, h: 400 },
        browser: { w: 550, h: 380 },
        videoContent: { w: 960, h: 720 },
        video: { w: 320, h: 180 },
        kasa: { w: 300, h: 380 }, // Approx
        printer: { w: 380, h: 380 } // Approx
    });
    const [activeDragElement, setActiveDragElement] = useState(null);

    // Z-Index Stacking Order (last element = highest z-index)
    const [zIndexOrder, setZIndexOrder] = useState([
        'visualizer', 'chat', 'tools', 'video', 'cad', 'browser', 'videoContent', 'kasa', 'printer'
    ]);

    // Hand Control State
    const [cursorPos, setCursorPos] = useState({ x: 0, y: 0 });
    const [isPinching, setIsPinching] = useState(false);
    const [isHandTrackingEnabled, setIsHandTrackingEnabled] = useState(false); // DEFAULT OFF
    const [cursorSensitivity, setCursorSensitivity] = useState(2.0);
    const [isCameraFlipped, setIsCameraFlipped] = useState(false); // Gesture control camera flip

    // Refs for Loop Access (Avoiding Closure Staleness)
    const isHandTrackingEnabledRef = useRef(false); // DEFAULT OFF
    const cursorSensitivityRef = useRef(2.0);
    const isCameraFlippedRef = useRef(false);
    const handLandmarkerRef = useRef(null);
    const cursorTrailRef = useRef([]); // Stores last N positions for trail
    const [ripples, setRipples] = useState([]); // Visual ripples on click

    // Web Audio Context for Mic Visualization
    const audioContextRef = useRef(null);
    const analyserRef = useRef(null);
    const sourceRef = useRef(null);
    const animationFrameRef = useRef(null);

    // Video Refs
    const videoRef = useRef(null);
    const canvasRef = useRef(null);
    const transmissionCanvasRef = useRef(null); // Dedicated canvas for resizing payload
    const videoIntervalRef = useRef(null);
    const lastFrameTimeRef = useRef(0);
    const frameCountRef = useRef(0);
    const lastVideoTimeRef = useRef(-1);

    // Ref to track video state for the loop (avoids closure staleness)
    const isVideoOnRef = useRef(false);
    const isModularModeRef = useRef(false);
    const elementPositionsRef = useRef(elementPositions);
    const activeDragElementRef = useRef(null);
    const lastActiveDragElementRef = useRef(null);
    const lastCursorPosRef = useRef({ x: 0, y: 0 });
    const lastWristPosRef = useRef({ x: 0, y: 0 }); // For stable fist gesture tracking
    const handConnectionsRef = useRef([]);

    // Smoothing and Snapping Refs
    const smoothedCursorPosRef = useRef({ x: 0, y: 0 });
    const snapStateRef = useRef({ isSnapped: false, element: null, snapPos: { x: 0, y: 0 } });

    // Mouse Drag Refs
    const dragOffsetRef = useRef({ x: 0, y: 0 });
    const isDraggingRef = useRef(false);

    const connectionBannerMessage = useMemo(() => {
        if (!isOnline) {
            return 'Device is offline. Reconnect to Wi-Fi or mobile data to reach A.D.A.';
        }
        if (connectionIssue) {
            return connectionIssue;
        }
        if (!socketConnected) {
            return 'Trying to reconnect to the A.D.A backend.';
        }
        if (isRemoteBrowserClient) {
            return 'Remote mobile mode is active. Voice uses the host desktop audio path; this phone is acting as the control surface.';
        }
        return '';
    }, [connectionIssue, isOnline, isRemoteBrowserClient, socketConnected]);

    const applyEnumeratedDevices = (devs) => {
        const audioInputs = devs.filter(d => d.kind === 'audioinput');
        const audioOutputs = devs.filter(d => d.kind === 'audiooutput');
        const videoInputs = devs.filter(d => d.kind === 'videoinput');

        setMicDevices(audioInputs);
        setSpeakerDevices(audioOutputs);
        setWebcamDevices(videoInputs);

        const savedMicId = localStorage.getItem('selectedMicId');
        if (savedMicId && audioInputs.some(d => d.deviceId === savedMicId)) {
            setSelectedMicId(savedMicId);
        } else if (audioInputs.length > 0) {
            setSelectedMicId(audioInputs[0].deviceId);
        }

        const savedSpeakerId = localStorage.getItem('selectedSpeakerId');
        if (savedSpeakerId && audioOutputs.some(d => d.deviceId === savedSpeakerId)) {
            setSelectedSpeakerId(savedSpeakerId);
        } else if (audioOutputs.length > 0) {
            setSelectedSpeakerId(audioOutputs[0].deviceId);
        }

        const savedWebcamId = localStorage.getItem('selectedWebcamId');
        if (savedWebcamId && videoInputs.some(d => d.deviceId === savedWebcamId)) {
            setSelectedWebcamId(savedWebcamId);
        } else if (videoInputs.length > 0) {
            setSelectedWebcamId(videoInputs[0].deviceId);
        }
    };

    const refreshMediaDevices = async () => {
        if (!navigator.mediaDevices?.enumerateDevices) {
            setMediaWarning('This browser does not expose media devices.');
            return;
        }

        try {
            const devs = await navigator.mediaDevices.enumerateDevices();
            applyEnumeratedDevices(devs);
        } catch (error) {
            console.error('Failed to enumerate devices:', error);
            setMediaWarning('Unable to read microphone or camera devices in this browser.');
        }
    };

    const requestMediaAccess = async ({ audio = false, video = false } = {}) => {
        if (!navigator.mediaDevices?.getUserMedia) {
            setMediaWarning('This browser does not support microphone or camera capture.');
            return false;
        }

        if (!secureMediaAvailable) {
            setMediaWarning('Microphone and camera access need HTTPS or localhost in mobile browsers.');
            return false;
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio,
                video
            });

            stream.getTracks().forEach(track => track.stop());
            setMediaPermissions(prev => ({
                audio: prev.audio || audio,
                video: prev.video || video
            }));
            setMediaWarning('');
            await refreshMediaDevices();
            return true;
        } catch (error) {
            console.error('Media permission request failed:', error);
            setMediaWarning(getMediaErrorMessage(error, video ? 'Camera' : 'Microphone'));
            return false;
        }
    };

    // Update refs when state changes
    useEffect(() => {
        isModularModeRef.current = isModularMode;
        elementPositionsRef.current = elementPositions;
        isHandTrackingEnabledRef.current = isHandTrackingEnabled;
        cursorSensitivityRef.current = cursorSensitivity;
        isCameraFlippedRef.current = isCameraFlipped;
        console.log("[Ref Sync] Camera flipped ref updated to:", isCameraFlipped);
    }, [isModularMode, elementPositions, isHandTrackingEnabled, cursorSensitivity, isCameraFlipped]);

    // Live Clock Update
    useEffect(() => {
        const timer = setInterval(() => {
            setCurrentTime(new Date());
        }, 1000);
        return () => clearInterval(timer);
    }, []);

    // Centering Logic (Startup & Resize)
    useEffect(() => {
        const centerElements = () => {
            const nextViewport = getViewportState();
            const { width, height, isMobileLayout: mobile, isCompactLayout: compact } = nextViewport;
            const topBarHeight = mobile ? 112 : 60;
            const gap = mobile ? 14 : 20;
            const safeWidth = Math.max(280, width - (mobile ? 24 : 0));

            let vizH = 400;
            let chatH = 250;

            if (mobile) {
                vizH = Math.max(180, Math.min(300, height * 0.24));
                chatH = Math.max(190, Math.min(280, height * 0.28));
            } else {
                const totalNeeded = topBarHeight + vizH + gap + chatH + gap + 140;

                if (height < totalNeeded) {
                    const available = height - topBarHeight - 140 - (gap * 2);
                    vizH = available * 0.6;
                    chatH = available * 0.4;
                }
            }

            const popupHeight = Math.min(height - topBarHeight - 28, Math.max(360, height * 0.72));
            const nextSizes = {
                visualizer: { w: mobile ? safeWidth : Math.min(600, width * 0.8), h: vizH },
                chat: { w: mobile ? safeWidth : Math.min(600, width * 0.9), h: chatH },
                tools: { w: mobile ? safeWidth : 500, h: mobile ? (compact ? 144 : 112) : 80 },
                cad: { w: mobile ? Math.min(safeWidth, 720) : 400, h: mobile ? popupHeight : 400 },
                browser: { w: mobile ? Math.min(safeWidth, 720) : 550, h: mobile ? popupHeight : 380 },
                videoContent: { w: mobile ? Math.min(safeWidth, 820) : Math.min(1100, width * 0.82), h: mobile ? Math.min(popupHeight, 760) : Math.min(760, height * 0.82) },
                video: {
                    w: mobile ? Math.min(176, Math.round(safeWidth * 0.42)) : 320,
                    h: mobile ? Math.round(Math.min(176, safeWidth * 0.42) * 9 / 16) : 180
                },
                kasa: { w: mobile ? Math.min(safeWidth, 420) : 300, h: mobile ? Math.min(popupHeight, 560) : 380 },
                printer: { w: mobile ? Math.min(safeWidth, 440) : 380, h: mobile ? Math.min(popupHeight, 560) : 380 }
            };

            const vizY = topBarHeight + (vizH / 2);
            const chatY = topBarHeight + vizH + gap;
            const toolsCenterY = mobile ? height - (compact ? 110 : 92) : height - 100;
            const popupCenter = { x: width / 2, y: topBarHeight + ((height - topBarHeight) / 2) };

            setViewport(nextViewport);
            setElementSizes(prev => ({
                ...prev,
                ...nextSizes
            }));

            setElementPositions(prev => ({
                ...prev,
                visualizer: {
                    x: width / 2,
                    y: vizY
                },
                chat: {
                    x: width / 2,
                    y: chatY
                },
                tools: {
                    x: width / 2,
                    y: toolsCenterY
                },
                cad: clampWithinViewport(prev.cad || popupCenter, nextSizes.cad, { topOffset: topBarHeight, bottomOffset: 20 }),
                browser: clampWithinViewport(prev.browser || popupCenter, nextSizes.browser, { topOffset: topBarHeight, bottomOffset: 20 }),
                videoContent: clampWithinViewport(prev.videoContent || popupCenter, nextSizes.videoContent, { topOffset: topBarHeight, bottomOffset: 20 }),
                kasa: clampWithinViewport(prev.kasa || popupCenter, nextSizes.kasa, { topOffset: topBarHeight, bottomOffset: 20 }),
                printer: clampWithinViewport(prev.printer || popupCenter, nextSizes.printer, { topOffset: topBarHeight, bottomOffset: 20 })
            }));
        };

        // Center on mount
        centerElements();

        // Center on resize
        window.addEventListener('resize', centerElements);
        return () => window.removeEventListener('resize', centerElements);
    }, []);

    // Utility: Clamp position to viewport so component stays fully visible
    const clampToViewport = (pos, size) => {
        return clampWithinViewport(pos, size, {
            margin: isMobileLayout ? 12 : 10,
            topOffset: isMobileLayout ? 112 : 60,
            bottomOffset: isMobileLayout ? 20 : 10
        });
    };

    // Utility: Get z-index for an element based on stacking order
    const getZIndex = (id) => {
        const baseZ = 30; // Above background elements
        const index = zIndexOrder.indexOf(id);
        return baseZ + (index >= 0 ? index : 0);
    };

    // Utility: Bring element to front (highest z-index)
    const bringToFront = (id) => {
        setZIndexOrder(prev => {
            const filtered = prev.filter(el => el !== id);
            return [...filtered, id]; // Move to end = highest z-index
        });
    };

    // Ref to track if model has been auto-connected (prevents duplicate connections)
    const hasAutoConnectedRef = useRef(false);

    // Auto-Connect Model on Start (Only after Auth and devices loaded)
    useEffect(() => {
        // Only auto-connect once: when socket connected, authenticated, and devices loaded
        if (!isRemoteBrowserClient && isConnected && isAuthenticated && socketConnected && micDevices.length > 0 && !hasAutoConnectedRef.current) {
            hasAutoConnectedRef.current = true;

            // Trigger Kasa and Printer Discovery
            socket.emit('discover_kasa');
            socket.emit('discover_printers');

            // Connect to model with small delay for socket stability
            const timer = setTimeout(() => {
                const index = micDevices.findIndex(d => d.deviceId === selectedMicId);
                const queryDevice = micDevices.find(d => d.deviceId === selectedMicId);
                const deviceName = queryDevice ? queryDevice.label : null;
                console.log("Auto-connecting to model with device:", deviceName, "Index:", index);

                setStatus('Connecting...');
                socket.emit('start_audio', {
                    device_index: index >= 0 ? index : null,
                    device_name: deviceName,
                    muted: isMuted
                });
            }, 500);
        }
    }, [isConnected, isAuthenticated, socketConnected, micDevices, selectedMicId, isRemoteBrowserClient]);

    useEffect(() => {
        // Socket IO Setup
        const handleConnect = () => {
            setStatus('Connected');
            setSocketConnected(true);
            setConnectionIssue('');
            socket.emit('get_settings');
        };
        const handleDisconnect = () => {
            setStatus('Disconnected');
            setSocketConnected(false);
            setConnectionIssue('Connection to the backend was lost. Reconnecting...');
        };
        const handleConnectError = (error) => {
            console.error('Socket connect error:', error);
            setSocketConnected(false);
            setConnectionIssue(error?.message ? `Backend unavailable: ${error.message}` : 'Backend unavailable. Check that the server is running on the host machine.');
        };

        socket.on('connect', handleConnect);
        socket.on('disconnect', handleDisconnect);
        socket.on('connect_error', handleConnectError);
        socket.io.on('reconnect_attempt', (attempt) => {
            setConnectionIssue(`Reconnecting to the backend (${attempt})...`);
        });
        socket.io.on('reconnect', () => {
            setConnectionIssue('');
        });
        socket.on('status', (data) => {
            addMessage('System', data.msg);
            // Update status bar based on backend messages
            if (data.msg === 'A.D.A Started') {
                setStatus('Model Connected');
            } else if (data.msg === 'A.D.A Stopped') {
                setStatus('Connected');
            }
        });
        socket.on('audio_data', (data) => {
            setAiAudioData(data.data);
        });
        socket.on('auth_status', (data) => {
            console.log("Auth Status:", data);
            setIsAuthenticated(data.authenticated);
            if (data.authenticated) {
                // If authenticated, hide lock screen with animation (handled by component if visible)
                // But simpler: just hide it
                // Actually, wait for animation if it WAS visible.
                // For now, let's just assume if authenticated -> hide
                // But we want the component to invoke onAnimationComplete.
                // If we are starting up (and face auth disabled), we want it FALSE immediately.
                if (!isLockScreenVisible) {
                    // Do nothing, already hidden
                }
            } else {
                // If NOT authenticated, show lock screen
                setIsLockScreenVisible(true);
            }
        });

        socket.on('settings', (settings) => {
            console.log("[Settings] Received:", settings);
            if (settings && typeof settings.face_auth_enabled !== 'undefined') {
                setFaceAuthEnabled(settings.face_auth_enabled);
                localStorage.setItem('face_auth_enabled', settings.face_auth_enabled);
            }
            if (typeof settings.camera_flipped !== 'undefined') {
                console.log("[Settings] Camera flip set to:", settings.camera_flipped);
                setIsCameraFlipped(settings.camera_flipped);
            }
        });
        socket.on('error', (data) => {
            console.error("Socket Error:", data);
            addMessage('System', `Error: ${data.msg}`);
        });
        socket.on('cad_data', (data) => {
            console.log("Received CAD Data:", data);
            setCadData(data);
            setCadThoughts(''); // Clear thoughts when generation complete
            setShowCadWindow(true); // Open window when data arrives
            // Auto-show the window if it's hidden, clamped to viewport
            if (!elementPositions.cad) {
                const size = { w: 400, h: 400 };
                const clamped = clampToViewport({ x: window.innerWidth / 2 + 150, y: window.innerHeight / 2 }, size);
                setElementPositions(prev => ({
                    ...prev,
                    cad: clamped
                }));
            }
        });
        socket.on('cad_status', (data) => {
            console.log("Received CAD Status:", data);
            // Extract retry info from extended payload
            if (data.attempt) {
                setCadRetryInfo({
                    attempt: data.attempt,
                    maxAttempts: data.max_attempts || 3,
                    error: data.error
                });
            }
            if (data.status === 'generating' || data.status === 'retrying') {
                setCadData({ format: 'loading' });
                setShowCadWindow(true);
                if (data.status === 'generating' && data.attempt === 1) {
                    setCadThoughts(''); // Clear previous thoughts for new generation
                }
                // Auto-show the window, clamped to viewport
                if (!elementPositions.cad) {
                    const size = { w: 400, h: 400 };
                    const clamped = clampToViewport({ x: window.innerWidth / 2 + 150, y: window.innerHeight / 2 }, size);
                    setElementPositions(prev => ({
                        ...prev,
                        cad: clamped
                    }));
                }
            } else if (data.status === 'failed') {
                // Keep loading state but show error
                setCadData({ format: 'loading' });
            }
        });
        socket.on('cad_thought', (data) => {
            // Append streaming thought text
            setCadThoughts(prev => prev + data.text);
        });
        socket.on('browser_frame', (data) => {
            setBrowserData(prev => ({
                image: data.image,
                logs: [...prev.logs, data.log].filter(l => l).slice(-50) // Keep last 50 logs
            }));
            setShowBrowserWindow(true);
            // Auto-show browser window if hidden, clamped to viewport
            if (!elementPositions.browser) {
                const size = { w: 550, h: 380 };
                const clamped = clampToViewport({ x: window.innerWidth / 2 - 200, y: window.innerHeight / 2 }, size);
                setElementPositions(prev => ({
                    ...prev,
                    browser: clamped
                }));
            }
        });
        socket.on('video_content_update', (data) => {
            setVideoContentData(prev => prev ? { ...prev, ...data } : { ...data });
            setVideoContentStatus(data.status || 'idle');
            setShowVideoStudioWindow(true);
            if (!elementPositions.videoContent) {
                const size = elementSizes.videoContent || { w: 960, h: 720 };
                const clamped = clampToViewport({ x: window.innerWidth / 2, y: window.innerHeight / 2 }, size);
                setElementPositions(prev => ({
                    ...prev,
                    videoContent: clamped
                }));
            }
        });
        socket.on('gemini_key_status', (data) => {
            setGeminiKeyStatus(data);
        });

        // Handle streaming transcription
        socket.on('transcription', (data) => {
            setMessages(prev => {
                const lastMsg = prev[prev.length - 1];

                // If the last message is from the same sender, append the chunk
                if (lastMsg && lastMsg.sender === data.sender) {
                    // Create a NEW object instead of mutating (prevents React StrictMode duplication)
                    return [
                        ...prev.slice(0, -1),
                        {
                            ...lastMsg,
                            text: lastMsg.text + data.text
                        }
                    ];
                } else {
                    // New message block
                    return [...prev, {
                        sender: data.sender,
                        text: data.text,
                        time: new Date().toLocaleTimeString()
                    }];
                }
            });
        });

        // Handle tool confirmation requests
        socket.on('tool_confirmation_request', (data) => {
            console.log("Received Confirmation Request:", data);
            setConfirmationRequest(data);
        });

        // Handle Print Window Request (from CadWindow)
        socket.on('request_print_window', () => {
            setShowPrinterWindow(true);
            const size = { w: 380, h: 380 };
            const clamped = clampToViewport({ x: window.innerWidth / 2, y: window.innerHeight / 2 }, size);
            setElementPositions(prev => ({
                ...prev,
                printer: clamped
            }));
        });

        // Kasa Devices
        socket.on('kasa_devices', (devices) => {
            console.log("Kasa Devices:", devices);
            setKasaDevices(devices);
        });

        socket.on('kasa_update', (data) => {
            setKasaDevices(prev => prev.map(d => {
                if (d.ip === data.ip) {
                    // Update only fields that are not null/undefined
                    return {
                        ...d,
                        is_on: data.is_on !== null ? data.is_on : d.is_on,
                        brightness: data.brightness !== null ? data.brightness : d.brightness
                    };
                }
                return d;
            }));
        });

        socket.on('project_update', (data) => {
            console.log("Project Update:", data.project);
            setCurrentProject(data.project);
            addMessage('System', `Switched to project: ${data.project}`);
        });

        // Track printer count for toolbar display
        socket.on('printer_list', (list) => {
            console.log('[PRINTERS] Count:', list.length);
            setPrinterCount(list.length);
        });

        // Slicing progress for top toolbar
        socket.on('slicing_progress', (data) => {
            console.log('[SLICING] Progress:', data);
            setSlicingStatus({
                active: data.percent < 100,
                percent: data.percent,
                message: data.message
            });
        });

        // Print status for top toolbar - track active prints
        socket.on('print_status_update', (data) => {
            console.log('[PRINT STATUS]', data);
            // Only show in toolbar if actively printing
            if (data.state && data.state.toLowerCase().includes('print')) {
                setActivePrintStatus({
                    printer: data.printer,
                    progress_percent: data.progress_percent,
                    time_elapsed: data.time_elapsed,
                    state: data.state
                });
            } else if (data.state && (data.state.toLowerCase() === 'idle' || data.state.toLowerCase() === 'standby' || data.state.toLowerCase() === 'complete')) {
                // Clear if print finished or idle
                setActivePrintStatus(null);
            }
        });



        refreshMediaDevices();

        return () => {
            socket.off('connect', handleConnect);
            socket.off('disconnect', handleDisconnect);
            socket.off('connect_error', handleConnectError);
            socket.off('status');
            socket.off('audio_data');
            socket.off('cad_data');
            socket.off('cad_thought');
            socket.off('cad_status');
            socket.off('browser_frame');
            socket.off('video_content_update');
            socket.off('gemini_key_status');
            socket.off('transcription');
            socket.off('tool_confirmation_request');
            socket.off('kasa_devices');
            socket.off('printer_list');
            socket.off('slicing_progress');
            socket.off('print_status_update');
            socket.off('error');

            stopMicVisualizer();
            stopVideo();
        };
    }, []);

    useEffect(() => {
        const handleOnline = () => {
            setIsOnline(true);
            setConnectionIssue('');
            if (!socket.connected) {
                socket.connect();
            }
        };

        const handleOffline = () => {
            setIsOnline(false);
            setConnectionIssue('Device is offline.');
        };

        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);

        return () => {
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
        };
    }, []);

    useEffect(() => {
        if (!isHandTrackingEnabled || handLandmarkerRef.current || !secureMediaAvailable) {
            return;
        }

        let cancelled = false;

        const initHandLandmarker = async () => {
            try {
                console.log('Initializing HandLandmarker...');
                const response = await fetch('/hand_landmarker.task');
                if (!response.ok) {
                    throw new Error(`Failed to fetch model: ${response.status} ${response.statusText}`);
                }

                const visionModule = await import('@mediapipe/tasks-vision');
                const vision = await visionModule.FilesetResolver.forVisionTasks(
                    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm'
                );

                if (cancelled) return;

                handConnectionsRef.current = visionModule.HandLandmarker.HAND_CONNECTIONS;
                handLandmarkerRef.current = await visionModule.HandLandmarker.createFromOptions(vision, {
                    baseOptions: {
                        modelAssetPath: '/hand_landmarker.task',
                        delegate: isMobileLayout ? 'CPU' : 'GPU'
                    },
                    runningMode: 'VIDEO',
                    numHands: 1
                });
                addMessage('System', 'Hand Tracking Ready');
            } catch (error) {
                console.error('Failed to initialize HandLandmarker:', error);
                setMediaWarning(getMediaErrorMessage(error, 'Camera'));
                addMessage('System', `Hand Tracking Error: ${error.message}`);
            }
        };

        initHandLandmarker();

        return () => {
            cancelled = true;
        };
    }, [isHandTrackingEnabled, isMobileLayout, secureMediaAvailable]);

    // Initial check in case we are already connected (fix race condition)
    useEffect(() => {
        if (socket.connected) {
            setStatus('Connected');
            socket.emit('get_settings');
        }
    }, []);

    // Persist device selections to localStorage when they change
    useEffect(() => {
        if (selectedMicId) {
            localStorage.setItem('selectedMicId', selectedMicId);
            console.log('[Settings] Saved microphone:', selectedMicId);
        }
    }, [selectedMicId]);

    useEffect(() => {
        if (selectedSpeakerId) {
            localStorage.setItem('selectedSpeakerId', selectedSpeakerId);
            console.log('[Settings] Saved speaker:', selectedSpeakerId);
        }
    }, [selectedSpeakerId]);

    useEffect(() => {
        if (selectedWebcamId) {
            localStorage.setItem('selectedWebcamId', selectedWebcamId);
            console.log('[Settings] Saved webcam:', selectedWebcamId);
        }
    }, [selectedWebcamId]);

    // Start/Stop Mic Visualizer
    useEffect(() => {
        if (selectedMicId && !isRemoteBrowserClient && secureMediaAvailable) {
            startMicVisualizer(selectedMicId);
        }
    }, [selectedMicId, isRemoteBrowserClient, secureMediaAvailable]);

    const startMicVisualizer = async (deviceId) => {
        stopMicVisualizer();

        if (!secureMediaAvailable || isRemoteBrowserClient) {
            return;
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { deviceId: { exact: deviceId } }
            });

            setMediaPermissions(prev => ({ ...prev, audio: true }));
            setMediaWarning('');

            audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
            analyserRef.current = audioContextRef.current.createAnalyser();
            analyserRef.current.fftSize = 64;

            sourceRef.current = audioContextRef.current.createMediaStreamSource(stream);
            sourceRef.current.connect(analyserRef.current);

            const updateMicData = () => {
                if (!analyserRef.current) return;
                const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
                analyserRef.current.getByteFrequencyData(dataArray);
                setMicAudioData(Array.from(dataArray));
                animationFrameRef.current = requestAnimationFrame(updateMicData);
            };

            updateMicData();
        } catch (err) {
            console.error("Error accessing microphone:", err);
            setMediaWarning(getMediaErrorMessage(err, 'Microphone'));
        }
    };

    const stopMicVisualizer = () => {
        if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
        if (sourceRef.current) sourceRef.current.disconnect();
        if (audioContextRef.current) audioContextRef.current.close();
    };

    const startVideo = async () => {
        if (!secureMediaAvailable) {
            setMediaWarning('Camera access needs HTTPS or localhost in mobile browsers.');
            return;
        }

        try {
            // Request 1080p resolution with selected webcam
            const constraints = {
                video: {
                    width: { ideal: 1920 },
                    height: { ideal: 1080 },
                    aspectRatio: 16 / 9
                }
            };

            // Use selected webcam if available
            if (selectedWebcamId) {
                constraints.video.deviceId = { exact: selectedWebcamId };
            }

            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            setMediaPermissions(prev => ({ ...prev, video: true }));
            setMediaWarning('');
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                videoRef.current.play();
            }

            // Initialize the transmission canvas
            if (!transmissionCanvasRef.current) {
                transmissionCanvasRef.current = document.createElement('canvas');
                transmissionCanvasRef.current.width = 640;
                transmissionCanvasRef.current.height = 360;
                console.log("Initialized transmission canvas (640x360)");
            }

            setIsVideoOn(true);
            isVideoOnRef.current = true; // Update ref for loop

            console.log("Starting video loop with webcam:", selectedWebcamId || "default");
            requestAnimationFrame(predictWebcam);

        } catch (err) {
            console.error("Error accessing camera:", err);
            setMediaWarning(getMediaErrorMessage(err, 'Camera'));
            addMessage('System', 'Error accessing camera');
        }
    };

    const predictWebcam = () => {
        // Use ref for checking state to avoid closure staleness
        if (!videoRef.current || !canvasRef.current || !isVideoOnRef.current) {
            return;
        }

        // Check if video has valid dimensions to prevent MediaPipe crash
        if (videoRef.current.readyState < 2 || videoRef.current.videoWidth === 0 || videoRef.current.videoHeight === 0) {
            requestAnimationFrame(predictWebcam);
            return;
        }

        // 1. Draw Video to Local Display Canvas (Native Resolution)
        const ctx = canvasRef.current.getContext('2d');

        // Ensure canvas matches video dimensions
        if (canvasRef.current.width !== videoRef.current.videoWidth || canvasRef.current.height !== videoRef.current.videoHeight) {
            canvasRef.current.width = videoRef.current.videoWidth;
            canvasRef.current.height = videoRef.current.videoHeight;
        }

        ctx.drawImage(videoRef.current, 0, 0, canvasRef.current.width, canvasRef.current.height);

        // 2. Send Frame to Backend (Throttled & Resized)
        // Only send if connected
        if (isConnected) {
            // Simple throttle: every 5th frame roughly
            if (frameCountRef.current % 5 === 0) {

                // Use dedicated transmission canvas for resizing
                const transCanvas = transmissionCanvasRef.current;
                if (transCanvas) {
                    const transCtx = transCanvas.getContext('2d');
                    // Draw resized image
                    transCtx.drawImage(videoRef.current, 0, 0, transCanvas.width, transCanvas.height);

                    // Convert resized image to blob
                    transCanvas.toBlob((blob) => {
                        if (blob) {
                            socket.emit('video_frame', { image: blob });
                        }
                    }, 'image/jpeg', 0.6); // Slightly higher compression for speed
                }
            }
        }


        // 3. Hand Tracking
        let startTimeMs = performance.now();
        // Use Ref for toggle check
        if (isHandTrackingEnabledRef.current && handLandmarkerRef.current && videoRef.current.currentTime !== lastVideoTimeRef.current) {
            lastVideoTimeRef.current = videoRef.current.currentTime;
            const results = handLandmarkerRef.current.detectForVideo(videoRef.current, startTimeMs);

            // Log every 100 frames to confirm loop is running
            if (frameCountRef.current % 100 === 0) {
                console.log("Tracking loop running... Last result:", results.landmarks.length > 0 ? "Hand Found" : "No Hand");
            }

            if (results.landmarks && results.landmarks.length > 0) {
                const landmarks = results.landmarks[0];

                // Log on first detection
                if (cursorPos.x === 0 && cursorPos.y === 0) {
                    console.log("First hand detection!", landmarks);
                }

                // Index Finger Tip (8)
                const indexTip = landmarks[8];
                // Thumb Tip (4)
                const thumbTip = landmarks[4];

                // Map to Screen Coords with Sensitivity Scaling
                // Sensitivity: Map center 50% of camera to 100% of screen.
                const SENSITIVITY = cursorSensitivityRef.current;

                // Apply camera flip if enabled (horizontal mirror)
                const rawX = isCameraFlippedRef.current ? (1 - indexTip.x) : indexTip.x;

                // 1. Normalize and Scale X
                let normX = (rawX - 0.5) * SENSITIVITY + 0.5;
                // Clamp to [0, 1]
                normX = Math.max(0, Math.min(1, normX));

                // 2. Normalize and Scale Y
                let normY = (indexTip.y - 0.5) * SENSITIVITY + 0.5;
                normY = Math.max(0, Math.min(1, normY));

                const targetX = normX * window.innerWidth;
                const targetY = normY * window.innerHeight;

                // 1. Smoothing (Lerp)
                // Factor 0.2 = smooth but responsive. Lower = smoother/slower.
                const lerpFactor = 0.2;
                smoothedCursorPosRef.current.x = smoothedCursorPosRef.current.x + (targetX - smoothedCursorPosRef.current.x) * lerpFactor;
                smoothedCursorPosRef.current.y = smoothedCursorPosRef.current.y + (targetY - smoothedCursorPosRef.current.y) * lerpFactor;

                let finalX = smoothedCursorPosRef.current.x;
                let finalY = smoothedCursorPosRef.current.y;

                // 2. Snap-to-Button Logic
                const SNAP_THRESHOLD = 50; // Pixels to snap
                const UNSNAP_THRESHOLD = 100; // Pixels to unsnap (Hysteresis)

                if (snapStateRef.current.isSnapped) {
                    // Check if we should unsnap
                    const dist = Math.sqrt(
                        Math.pow(finalX - snapStateRef.current.snapPos.x, 2) +
                        Math.pow(finalY - snapStateRef.current.snapPos.y, 2)
                    );

                    if (dist > UNSNAP_THRESHOLD) {
                        // REMOVE HIGHLIGHT
                        if (snapStateRef.current.element) {
                            snapStateRef.current.element.classList.remove('snap-highlight');
                            snapStateRef.current.element.style.boxShadow = '';
                            snapStateRef.current.element.style.backgroundColor = '';
                            snapStateRef.current.element.style.borderColor = '';
                        }

                        snapStateRef.current = { isSnapped: false, element: null, snapPos: { x: 0, y: 0 } };
                    } else {
                        // Stay snapped
                        finalX = snapStateRef.current.snapPos.x;
                        finalY = snapStateRef.current.snapPos.y;
                    }
                } else {
                    // Check if we should snap
                    // Find all interactive elements
                    const targets = Array.from(document.querySelectorAll('button, input, select, .draggable'));
                    let closest = null;
                    let minDist = Infinity;

                    for (const el of targets) {
                        const rect = el.getBoundingClientRect();
                        const centerX = rect.left + rect.width / 2;
                        const centerY = rect.top + rect.height / 2;
                        const dist = Math.sqrt(Math.pow(finalX - centerX, 2) + Math.pow(finalY - centerY, 2));

                        if (dist < minDist) {
                            minDist = dist;
                            closest = { el, centerX, centerY };
                        }
                    }

                    if (closest && minDist < SNAP_THRESHOLD) {
                        snapStateRef.current = {
                            isSnapped: true,
                            element: closest.el,
                            snapPos: { x: closest.centerX, y: closest.centerY }
                        };
                        finalX = closest.centerX;
                        finalY = closest.centerY;

                        // SNAP HIGHLIGHT Logic
                        closest.el.classList.add('snap-highlight');
                        // Add some inline style for the glow if class isn't enough (using imperative for speed)
                        closest.el.style.boxShadow = '0 0 20px rgba(34, 211, 238, 0.6)';
                        closest.el.style.backgroundColor = 'rgba(6, 182, 212, 0.2)';
                        closest.el.style.borderColor = 'rgba(34, 211, 238, 1)';
                    }
                }

                // Update Cursor Loop
                setCursorPos({ x: finalX, y: finalY });

                // Trail Logic: Removed per user request

                // Pinch Detection (Distance between Index and Thumb)
                const distance = Math.sqrt(
                    Math.pow(indexTip.x - thumbTip.x, 2) + Math.pow(indexTip.y - thumbTip.y, 2)
                );

                const isPinchNow = distance < 0.05; // Threshold
                if (isPinchNow && !isPinching) {
                    // Click Triggered
                    console.log("Click triggered at", finalX, finalY);

                    // Ripple Effect: Removed per user request

                    const el = document.elementFromPoint(finalX, finalY);
                    if (el) {
                        // Find closest clickable element (button, input, etc.)
                        const clickable = el.closest('button, input, a, [role="button"]');
                        if (clickable && typeof clickable.click === 'function') {
                            clickable.click();
                        } else if (typeof el.click === 'function') {
                            el.click();
                        }
                    }
                }
                setIsPinching(isPinchNow);

                // Fist Detection for Gesture-Based Dragging (Popup Windows Only)
                // Detects if all fingers are folded (tips closer to wrist than MCPs)
                const isFingerFolded = (tipIdx, mcpIdx) => {
                    const tip = landmarks[tipIdx];
                    const mcp = landmarks[mcpIdx];
                    const wrist = landmarks[0];
                    const distTip = Math.sqrt(Math.pow(tip.x - wrist.x, 2) + Math.pow(tip.y - wrist.y, 2));
                    const distMcp = Math.sqrt(Math.pow(mcp.x - wrist.x, 2) + Math.pow(mcp.y - wrist.y, 2));
                    return distTip < distMcp; // Folded if tip is closer
                };

                const isFist = isFingerFolded(8, 5) && isFingerFolded(12, 9) && isFingerFolded(16, 13) && isFingerFolded(20, 17);

                // Get wrist position in screen coordinates (stable reference for fist gesture)
                const wrist = landmarks[0];
                const wristRawX = isCameraFlippedRef.current ? (1 - wrist.x) : wrist.x;
                const wristNormX = Math.max(0, Math.min(1, (wristRawX - 0.5) * SENSITIVITY + 0.5));
                const wristNormY = Math.max(0, Math.min(1, (wrist.y - 0.5) * SENSITIVITY + 0.5));
                const wristScreenX = wristNormX * window.innerWidth;
                const wristScreenY = wristNormY * window.innerHeight;

                if (isFist) {
                    if (!activeDragElementRef.current) {
                        // Only check popup windows (draggable elements)
                        const draggableElements = ['cad', 'browser', 'videoContent', 'kasa', 'printer'];

                        for (const id of draggableElements) {
                            const el = document.getElementById(id);
                            if (el) {
                                const rect = el.getBoundingClientRect();
                                // Use the cursor position from before fist was made for hit detection
                                if (finalX >= rect.left && finalX <= rect.right && finalY >= rect.top && finalY <= rect.bottom) {
                                    activeDragElementRef.current = id;
                                    bringToFront(id);
                                    // Lock the initial wrist position when starting drag
                                    lastWristPosRef.current = { x: wristScreenX, y: wristScreenY };
                                    break;
                                }
                            }
                        }
                    }

                    if (activeDragElementRef.current) {
                        // Use WRIST movement (not index finger) for stable dragging
                        // The wrist doesn't move when making a fist
                        const dx = wristScreenX - lastWristPosRef.current.x;
                        const dy = wristScreenY - lastWristPosRef.current.y;

                        // Update position only if there's actual movement
                        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
                            updateElementPosition(activeDragElementRef.current, dx, dy);
                        }

                        // Update last wrist position
                        lastWristPosRef.current = { x: wristScreenX, y: wristScreenY };
                    }
                } else {
                    activeDragElementRef.current = null;
                }

                // Sync state for visual feedback (only on change)
                if (activeDragElementRef.current !== lastActiveDragElementRef.current) {
                    setActiveDragElement(activeDragElementRef.current);
                    lastActiveDragElementRef.current = activeDragElementRef.current;
                }

                lastCursorPosRef.current = { x: finalX, y: finalY };

                // Draw Skeleton
                drawSkeleton(ctx, landmarks);
            }

        }

        // 4. FPS Calculation
        const now = performance.now();
        frameCountRef.current++;
        if (now - lastFrameTimeRef.current >= 1000) {
            setFps(frameCountRef.current);
            frameCountRef.current = 0;
            lastFrameTimeRef.current = now;
        }

        if (isVideoOnRef.current) {
            requestAnimationFrame(predictWebcam);
        }
    };

    const drawSkeleton = (ctx, landmarks) => {
        ctx.strokeStyle = '#00FFFF';
        ctx.lineWidth = 2;

        // Connections
        const connections = handConnectionsRef.current;
        if (!connections?.length) {
            return;
        }
        for (const connection of connections) {
            const start = landmarks[connection.start];
            const end = landmarks[connection.end];
            ctx.beginPath();
            ctx.moveTo(start.x * canvasRef.current.width, start.y * canvasRef.current.height);
            ctx.lineTo(end.x * canvasRef.current.width, end.y * canvasRef.current.height);
            ctx.stroke();
        }
    };

    const stopVideo = () => {
        if (videoRef.current && videoRef.current.srcObject) {
            videoRef.current.srcObject.getTracks().forEach(track => track.stop());
            videoRef.current.srcObject = null;
        }
        setIsVideoOn(false);
        isVideoOnRef.current = false; // Update ref
        setFps(0);
    };

    const toggleVideo = () => {
        if (isVideoOn) {
            stopVideo();
        } else {
            requestMediaAccess({ video: true }).then((granted) => {
                if (granted) {
                    startVideo();
                }
            });
        }
    };

    const addMessage = (sender, text) => {
        setMessages(prev => [...prev, { sender, text, time: new Date().toLocaleTimeString() }]);
    };

    const togglePower = () => {
        if (isRemoteBrowserClient) {
            setMediaWarning('Remote mobile mode can control windows and devices, but live voice still uses the host desktop audio path.');
            return;
        }

        if (!secureMediaAvailable) {
            setMediaWarning('Microphone access needs HTTPS or localhost in mobile browsers.');
            return;
        }

        if (isConnected) {
            socket.emit('stop_audio');
            setIsConnected(false);
            setIsMuted(false); // Reset mute state
        } else {
            requestMediaAccess({ audio: true }).then((granted) => {
                if (!granted) return;

                const index = micDevices.findIndex(d => d.deviceId === selectedMicId);
                socket.emit('start_audio', { device_index: index >= 0 ? index : null });
                setIsConnected(true);
                setIsMuted(false);
            });
        }
    };

    const toggleMute = () => {
        if (isRemoteBrowserClient) {
            setMediaWarning('Mute control is disabled in remote mobile mode because audio stays on the host desktop path.');
            return;
        }

        if (!isConnected) return; // Can't mute if not connected

        if (isMuted) {
            socket.emit('resume_audio');
            setIsMuted(false);
        } else {
            socket.emit('pause_audio');
            setIsMuted(true);
        }
    };

    const handleSend = (textOrEvent) => {
        const text = typeof textOrEvent === 'string' ? textOrEvent : inputValue;
        if (!text?.trim()) return;
        socket.emit('user_input', { text });
        addMessage('You', text);
        setInputValue('');
    };

    const clearTranscript = () => setMessages([]);

    const handleMinimize = () => ipcRenderer?.send('window-minimize');
    const handleMaximize = () => ipcRenderer?.send('window-maximize');

    // Close Application - memory is now actively saved to project, no prompt needed
    const handleCloseRequest = () => {
        // Emit shutdown signal to backend for graceful shutdown
        // Use volatile emit with timeout fallback to ensure window closes even if server is unresponsive
        const closeWindow = () => {
            if (ipcRenderer) {
                ipcRenderer.send('window-close');
                return;
            }

            if (typeof window !== 'undefined') {
                window.close();
            }
        };

        if (socket.connected) {
            console.log('[APP] Sending shutdown signal to backend...');
            socket.emit('shutdown', {}, (ack) => {
                // This callback may not be called if server uses os._exit
                console.log('[APP] Shutdown acknowledged');
                closeWindow();
            });
            // Fallback: close after 500ms if ack doesn't come back
            setTimeout(closeWindow, 500);
        } else {
            // Socket not connected, just close
            closeWindow();
        }
    };

    const handleFileUpload = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const textContent = event.target.result;
                // Just send the text content directly
                if (typeof textContent === 'string' && textContent.length > 0) {
                    socket.emit('upload_memory', { memory: textContent });
                    addMessage('System', 'Uploading memory...');
                } else {
                    addMessage('System', 'Empty or invalid memory file');
                }
            } catch (err) {
                console.error("Error reading file:", err);
                addMessage('System', 'Error reading memory file');
            }
        };
        reader.readAsText(file);
    };

    // handleCancelClose removed - no longer using memory prompt

    const handleConfirmTool = () => {
        if (confirmationRequest) {
            socket.emit('confirm_tool', { id: confirmationRequest.id, confirmed: true });
            setConfirmationRequest(null);
        }
    };

    const handleDenyTool = () => {
        if (confirmationRequest) {
            socket.emit('confirm_tool', { id: confirmationRequest.id, confirmed: false });
            setConfirmationRequest(null);
        }
    };

    // Updated Bounds Checking Logic
    const updateElementPosition = (id, dx, dy) => {
        setElementPositions(prev => {
            const currentPos = prev[id];
            const size = elementSizes[id] || { w: 100, h: 100 }; // Fallback
            let newX = currentPos.x + dx;
            let newY = currentPos.y + dy;

            // Bounds Logic
            // Depends on anchor point.
            // Visualizer, Tools, Cad, Browser, Kasa: translate(-50%, -50%) -> Center Anchor
            // Chat: translate(-50%, 0) -> Top-Center Anchor
            // Video: Top-Left Anchor (default div)

            const width = window.innerWidth;
            const height = window.innerHeight;
            const margin = 0; // Strict bounds

            if (id === 'chat') {
                // Anchor: Top-Center (x is center, y is top)
                // X Bounds: size.w/2 <= x <= width - size.w/2
                newX = Math.max(size.w / 2 + margin, Math.min(width - size.w / 2 - margin, newX));
                // Y Bounds: 0 <= y <= height - size.h
                newY = Math.max(margin, Math.min(height - size.h - margin, newY));

            } else if (id === 'video') {
                // Anchor: Top-Left
                newX = Math.max(margin, Math.min(width - size.w - margin, newX));
                newY = Math.max(margin, Math.min(height - size.h - margin, newY));

            } else {
                // Anchor: Center
                newX = Math.max(size.w / 2 + margin, Math.min(width - size.w / 2 - margin, newX));
                newY = Math.max(size.h / 2 + margin, Math.min(height - size.h / 2 - margin, newY));
            }

            return {
                ...prev,
                [id]: {
                    x: newX,
                    y: newY
                }
            };
        });
    };

    // --- MOUSE DRAG HANDLERS ---
    const handleMouseDown = (e, id) => {
        console.log(`[MouseDrag] MouseDown on ${id}`, { target: e.target.tagName });

        // Fixed elements that should never be draggable (even in modular mode)
        const fixedElements = ['visualizer', 'chat', 'video', 'tools'];
        if (fixedElements.includes(id)) {
            console.log(`[MouseDrag] ${id} is a fixed element, not draggable`);
            return;
        }

        // Bring clicked element to front (z-index)
        bringToFront(id);

        // Prevent dragging if interacting with inputs, buttons, or canvas (for 3D controls)
        const tagName = e.target.tagName.toLowerCase();
        if (tagName === 'input' || tagName === 'button' || tagName === 'textarea' || tagName === 'canvas' || e.target.closest('button')) {
            console.log("[MouseDrag] Interaction blocked by interactive element");
            return;
        }

        // Check if clicking on a drag handle section (data-drag-handle attribute)
        const isDragHandle = e.target.closest('[data-drag-handle]');
        if (!isDragHandle && !isModularModeRef.current) {
            // If not clicking a drag handle and modular mode is off, don't drag
            // This allows popup windows to have dedicated drag areas
            console.log("[MouseDrag] Not a drag handle and modular mode off");
            return;
        }

        const elPos = elementPositions[id];
        if (!elPos) return;

        // Calculate offset based on anchor point
        // Most are Center Anchored (x, y is center)
        // Chat is Top-Center Anchored (x is center, y is top)
        // Video is Top-Left Anchored (x is left, y is top)

        // We want: MousePos = ElementPos + Offset
        // So: Offset = MousePos - ElementPos
        dragOffsetRef.current = {
            x: e.clientX - elPos.x,
            y: e.clientY - elPos.y
        };

        setActiveDragElement(id);
        activeDragElementRef.current = id;
        isDraggingRef.current = true;

        window.addEventListener('mousemove', handleMouseDrag);
        window.addEventListener('mouseup', handleMouseUp);
    };

    const handleMouseDrag = (e) => {
        if (!isDraggingRef.current || !activeDragElementRef.current) return;

        const id = activeDragElementRef.current;
        const currentPos = elementPositionsRef.current[id];
        if (!currentPos) return;

        // Target Position = MousePos - Offset
        // But we want delta for updateElementPosition??
        // actually updateElementPosition takes dx, dy.
        // Let's just set the position directly or calculate delta.
        // Since updateElementPosition has bounds logic, let's use it, but we need delta from PREVIOUS position?
        // OR we can refactor updateElementPosition to take absolute.
        // Let's stick to calculating new position and manually updating state with bounds logic inside a setter.

        // Actually, updateElementPosition uses setElementPositions(prev => ...).
        // Let's duplicate bounds logic for mouse drag to be precise or reuse.
        // reusing updateElementPosition requires calculating dx/dy from *current state* which might be lagging in the closure?
        // No, functional update is fine.

        // But for smooth mouse drag, absolute position is better.
        const rawNewX = e.clientX - dragOffsetRef.current.x;
        const rawNewY = e.clientY - dragOffsetRef.current.y;

        setElementPositions(prev => {
            const size = elementSizes[id] || { w: 100, h: 100 }; // Fallback
            let newX = rawNewX;
            let newY = rawNewY;

            const width = window.innerWidth;
            const height = window.innerHeight;
            const margin = 0;

            if (id === 'chat') {
                newX = Math.max(size.w / 2 + margin, Math.min(width - size.w / 2 - margin, newX));
                newY = Math.max(margin, Math.min(height - size.h - margin, newY));
            } else if (id === 'video') {
                newX = Math.max(margin, Math.min(width - size.w - margin, newX));
                newY = Math.max(margin, Math.min(height - size.h - margin, newY));
            } else {
                newX = Math.max(size.w / 2 + margin, Math.min(width - size.w / 2 - margin, newX));
                newY = Math.max(size.h / 2 + margin, Math.min(height - size.h / 2 - margin, newY));
            }

            return {
                ...prev,
                [id]: { x: newX, y: newY }
            };
        });
    };

    const handleMouseUp = () => {
        isDraggingRef.current = false;
        setActiveDragElement(null);
        activeDragElementRef.current = null;
        window.removeEventListener('mousemove', handleMouseDrag);
        window.removeEventListener('mouseup', handleMouseUp);
    };

    // Calculate Average Audio Amplitude for Background Pulse
    const audioAmp = aiAudioData.reduce((a, b) => a + b, 0) / aiAudioData.length / 255;

    const toggleKasaWindow = () => {
        if (!showKasaWindow) {
            // Maybe trigger discover instantly?
            if (kasaDevices.length === 0) socket.emit('discover_kasa');
        }
        setShowKasaWindow(!showKasaWindow);
    };

    const togglePrinterWindow = () => {
        setShowPrinterWindow(!showPrinterWindow);
    };

    const toggleVideoStudioWindow = () => {
        setShowVideoStudioWindow(!showVideoStudioWindow);
    };



    return (
        <div className="h-screen w-screen overflow-hidden bg-black text-[#E6FBFF]">
            <video ref={videoRef} autoPlay muted className="hidden" />
            <canvas ref={canvasRef} className="hidden" />
            {isLockScreenVisible && (
                <Suspense fallback={<LoadingPanel label="Loading auth..." />}>
                    <AuthLock
                        socket={socket}
                        onAuthenticated={() => setIsAuthenticated(true)}
                        onAnimationComplete={() => setIsLockScreenVisible(false)}
                    />
                </Suspense>
            )}
            <MobileShell
                socket={socket}
                status={status}
                messages={messages}
                onSend={handleSend}
                onClearTranscript={clearTranscript}
                isLive={isConnected && !isMuted}
                audioBytes={aiAudioData}
                micLevel={micAudioData.reduce((sum, value) => sum + value, 0) / (micAudioData.length || 1)}
                onToggleSession={togglePower}
                onInterrupt={() => socket.emit('interrupt_audio')}
                kasaDevices={kasaDevices}
                onOpenCad={() => setShowCadWindow(true)}
                onOpenPrinters={() => setShowPrinterWindow(true)}
                onOpenWeb={() => setShowBrowserWindow(true)}
                onOpenLegacyStudio={() => setShowVideoStudioWindow(true)}
                deviceProps={{
                    micDevices,
                    speakerDevices,
                    webcamDevices,
                    selectedMicId,
                    setSelectedMicId,
                    selectedSpeakerId,
                    setSelectedSpeakerId,
                    selectedWebcamId,
                    setSelectedWebcamId,
                    cursorSensitivity,
                    setCursorSensitivity,
                    isCameraFlipped,
                    setIsCameraFlipped,
                    handleFileUpload,
                    mobileLayout: true,
                }}
            />
            {showCadWindow && (
                <div className="fixed inset-0 z-50 flex flex-col bg-black">
                    <button type="button" onClick={() => setShowCadWindow(false)} className="px-4 py-3 text-left font-mono text-sm tracking-[2px] text-[#22D3EE]">Back · CAD</button>
                    <div className="min-h-0 flex-1">
                        <Suspense fallback={<LoadingPanel label="Loading CAD..." />}>
                            <CadWindow data={cadData} thoughts={cadThoughts} retryInfo={cadRetryInfo} onClose={() => setShowCadWindow(false)} socket={socket} mobileLayout />
                        </Suspense>
                    </div>
                </div>
            )}
            {showBrowserWindow && (
                <div className="fixed inset-0 z-50 flex flex-col bg-black">
                    <button type="button" onClick={() => setShowBrowserWindow(false)} className="px-4 py-3 text-left font-mono text-sm tracking-[2px] text-[#22D3EE]">Back · Web</button>
                    <div className="min-h-0 flex-1">
                        <Suspense fallback={<LoadingPanel label="Loading browser..." />}>
                            <BrowserWindow imageSrc={browserData.image} logs={browserData.logs} onClose={() => setShowBrowserWindow(false)} socket={socket} mobileLayout />
                        </Suspense>
                    </div>
                </div>
            )}
            {showPrinterWindow && (
                <div className="fixed inset-0 z-50 flex flex-col bg-black">
                    <button type="button" onClick={() => setShowPrinterWindow(false)} className="px-4 py-3 text-left font-mono text-sm tracking-[2px] text-[#22D3EE]">Back · Printers</button>
                    <div className="min-h-0 flex-1 overflow-auto">
                        <Suspense fallback={<LoadingPanel label="Loading printers..." />}>
                            <PrinterWindow socket={socket} onClose={() => setShowPrinterWindow(false)} mobileLayout />
                        </Suspense>
                    </div>
                </div>
            )}
            {showVideoStudioWindow && (
                <div className="fixed inset-0 z-50 flex flex-col bg-black">
                    <button type="button" onClick={() => setShowVideoStudioWindow(false)} className="px-4 py-3 text-left font-mono text-sm tracking-[2px] text-[#22D3EE]">Back · Runway / InVideo / Canva</button>
                    <div className="min-h-0 flex-1 overflow-auto">
                        <Suspense fallback={<LoadingPanel label="Loading video studio..." />}>
                            <VideoContentWindow socket={socket} data={videoContentData} status={videoContentStatus} onClose={() => setShowVideoStudioWindow(false)} mobileLayout />
                        </Suspense>
                    </div>
                </div>
            )}
            <Suspense fallback={null}>
                <ConfirmationPopup request={confirmationRequest} onConfirm={handleConfirmTool} onDeny={handleDenyTool} />
            </Suspense>
        </div>
    );
}

export default App;
