import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Peer, { DataConnection } from 'peerjs';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Mic, MicOff, Video, VideoOff, PhoneOff, Users, UserCheck, FileText, ChevronRight, Save, CheckCircle, MessageSquare, Signal, Settings, Volume2, Send, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { API_BASE_URL } from '@/services/apiConfig';

import { getCompanyData } from '@/lib/companyStore';
import { whisperService } from '@/services/whisperService';


interface TranscriptMsg {
    speaker: string;
    text: string;
    timestamp: string;
}



const HRInterviewPortal = () => {
    const navigate = useNavigate();
    const location = useLocation();

    // Role Determination (supports location.state or ?role=interviewer)
    const urlParams = new URLSearchParams(location.search);
    const role = location.state?.role || urlParams.get('role') || 'candidate';
    const isInterviewer = role === 'interviewer';

    // State
    const [myPeerId, setMyPeerId] = useState<string>('');
    const [remotePeerId, setRemotePeerId] = useState<string>('');
    const [isConnected, setIsConnected] = useState(false);
    const [isMicOn, setIsMicOn] = useState(true);
    const [isVideoOn, setIsVideoOn] = useState(true);
    const [isVolumeOn, setIsVolumeOn] = useState(true);

    // Form State
    const [notes, setNotes] = useState('');
    const [decision, setDecision] = useState('Hold');
    const [isSaving, setIsSaving] = useState(false);
    const [isInterviewActive, setIsInterviewActive] = useState(false);
    const [interviewStartTime, setInterviewStartTime] = useState<Date | null>(null);
    const [elapsedTime, setElapsedTime] = useState('00:00:00');
    const [guideCollapsed, setGuideCollapsed] = useState(false);

    // Transcription State
    const [transcripts, setTranscripts] = useState<TranscriptMsg[]>([]);
    const [isTranscribing, setIsTranscribing] = useState(false);
    const [debugStatus, setDebugStatus] = useState<string[]>([]);
    const [volumeLevel, setVolumeLevel] = useState(0);
    const [candidateName, setCandidateName] = useState<string>('Candidate');
    const [candidateInfo, setCandidateInfo] = useState<any>(null);
    const [isProcessing, setIsProcessing] = useState(false);

    const addDebug = (msg: string) => setDebugStatus(prev => [msg, ...prev].slice(0, 5));

    // Refs for stable references
    const myVideoRef = useRef<HTMLVideoElement>(null);
    const remoteVideoRef = useRef<HTMLVideoElement>(null);
    const peerInstance = useRef<Peer | null>(null);
    const connInstance = useRef<DataConnection | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const remoteStreamRef = useRef<MediaStream | null>(null); // Store remote stream for delayed attachment
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const callRef = useRef<any>(null);
    const screenStreamRef = useRef<MediaStream | null>(null);
    const transcriptEndRef = useRef<HTMLDivElement>(null);
    const [isScreenSharing, setIsScreenSharing] = useState(false);
    const micRef = useRef(isMicOn); // Ref for closures
    const isConnectedRef = useRef(isConnected);

    // Sync refs
    useEffect(() => { micRef.current = isMicOn; }, [isMicOn]);
    useEffect(() => { isConnectedRef.current = isConnected; }, [isConnected]);

    // Timer effect
    useEffect(() => {
        if (!interviewStartTime) return;
        const interval = setInterval(() => {
            const now = new Date();
            const diff = Math.floor((now.getTime() - interviewStartTime.getTime()) / 1000);
            const hrs = Math.floor(diff / 3600);
            const mins = Math.floor((diff % 3600) / 60);
            const secs = diff % 60;
            setElapsedTime(
                `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
            );
        }, 1000);
        return () => clearInterval(interval);
    }, [interviewStartTime]);

    // Housekeeping
    const companyData = getCompanyData();
    const SESSION_ID = urlParams.get('session') || '3000'; // Default to 3000
    const HOST_ID = `mockello-hr-${SESSION_ID}`;
    const CANDIDATE_ID = `mockello-candidate-${SESSION_ID}`;
    // Swap IDs: If I'm the interviewer, I want my ID to be HOST_ID.
    const myId = isInterviewer ? HOST_ID : CANDIDATE_ID;
    const targetPeerId = isInterviewer ? CANDIDATE_ID : HOST_ID;

    // Auto-scroll transcript
    useEffect(() => {
        transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [transcripts]);

    // Attach remote stream when connected and video element is ready
    useEffect(() => {
        if (isConnected && remoteVideoRef.current && remoteStreamRef.current) {
            console.log("[WebRTC] Attaching remote stream to video element");
            remoteVideoRef.current.srcObject = remoteStreamRef.current;
        }
    }, [isConnected]);

    // --- Transcription Logic (Groq + VAD) ---
    const SPEECH_THRESHOLD = 5; // Reduced from 15 to 5
    const MIN_SPEECH_FRAMES = 2; // Reduced from 5 to 2

    const processAudioChunk = async (blob: Blob, speechFrames: number, maxVol: number) => {
        // More sensitive check
        if (speechFrames < 1 && maxVol < 5) {
            addDebug(`Skip: Silence (Frames: ${speechFrames}, Peak: ${maxVol})`);
            return;
        }

        addDebug(`Transcribing... (${blob.size}b)`);
        setIsProcessing(true);
        try {
            const text = await whisperService.transcribeAudio(blob);
            if (!text || text.trim().length < 2) {
                addDebug("Silence/Empty");
                return;
            }

            // Hallucination Filtering (Only if EXACT match for common ones)
            const hallucinations = [
                'thank you', 'thanks for watching', 'subtitle by', 'amara.org', 'support us', 'copyright',
                'all rights reserved', 'translated by', 'transcribed by', '.'
            ];

            const cleanup = text.trim();
            if (hallucinations.includes(cleanup.toLowerCase())) {
                addDebug("Filtered Noise");
                return;
            }

            // Success
            console.log(`[Transcription] Result: "${cleanup}"`);
            addDebug(`Result: ${cleanup.substring(0, 15)}...`);

            const newMsg: TranscriptMsg = {
                speaker: isInterviewer ? 'HR' : 'Candidate',
                text: cleanup,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };

            setTranscripts(prev => [...prev, newMsg]);

            // Send to peer
            if (connInstance.current && connInstance.current.open) {
                connInstance.current.send({ type: 'transcript', payload: newMsg });
            }

        } catch (e) {
            console.error(e);
            addDebug("Error: Whisper Failed");
        } finally {
            setIsProcessing(false);
        }
    };

    const startRecording = useCallback(async () => {
        if (!streamRef.current) return;

        setIsTranscribing(true);
        addDebug("Starting Recorder...");

        let mimeType = 'audio/webm';
        if (!MediaRecorder.isTypeSupported(mimeType)) {
            mimeType = 'audio/ogg';
            if (!MediaRecorder.isTypeSupported(mimeType)) {
                mimeType = 'audio/mp4';
                if (!MediaRecorder.isTypeSupported(mimeType)) {
                    mimeType = ''; // Let browser decide
                }
            }
        }

        const mediaRecorder = new MediaRecorder(streamRef.current, mimeType ? { mimeType } : {});
        mediaRecorderRef.current = mediaRecorder;

        // VAD State for current chunk
        let currentSpeechFrames = 0;
        let maxVol = 0;
        let audioContext: AudioContext | null = null;
        let analyzer: AnalyserNode | null = null;
        let source: MediaStreamAudioSourceNode | null = null;
        let intervalId: any = null;

        try {
            audioContext = new AudioContext();
            source = audioContext.createMediaStreamSource(streamRef.current);
            analyzer = audioContext.createAnalyser();
            analyzer.fftSize = 256;
            source.connect(analyzer);

            const bufferLength = analyzer.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);

            // Check volume 10 times a second
            intervalId = setInterval(() => {
                if (!isTranscribing) return; // Stop checking if stopped
                analyzer?.getByteFrequencyData(dataArray);
                const sum = dataArray.reduce((src, a) => src + a, 0);
                const avg = sum / bufferLength;

                // Update UI visualization
                const vol = Math.round(avg);
                setVolumeLevel(vol);
                if (vol > maxVol) maxVol = vol;

                if (avg > SPEECH_THRESHOLD) {
                    currentSpeechFrames++;
                }
            }, 100);

        } catch (e) { console.error("Audio Context Error", e); }

        mediaRecorder.ondataavailable = async (event) => {
            if (event.data.size > 0) {
                // Process the chunk we just finished recording
                const frames = currentSpeechFrames;
                const peak = maxVol;
                currentSpeechFrames = 0; // Reset for next chunk
                maxVol = 0;
                await processAudioChunk(event.data, frames, peak);
            }
        };

        mediaRecorder.start(2500); // Shorter chunks (2.5s) for better responsiveness

        // Cleanup function stored in ref or effect
        return () => {
            clearInterval(intervalId);
            audioContext?.close();
        };

    }, [isInterviewer]);

    const stopTranscription = useCallback(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
            mediaRecorderRef.current.stop();
        }
        setIsTranscribing(false);
        addDebug("Stopped manually");
    }, []);

    const startTranscription = () => {
        startRecording();
    };

    // Cleanup recognition on unmount
    // Cleanup recognition on unmount
    useEffect(() => {
        return () => {
            if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
                mediaRecorderRef.current.stop();
            }
        };
    }, []);



    // --- Connection Handlers ---
    const handleConnection = useCallback((conn: DataConnection) => {
        connInstance.current = conn;
        conn.on('open', () => console.log("[Data] Link Open"));
        conn.on('data', (data: any) => {
            if (data.type === 'transcript') {
                setTranscripts(prev => [...prev, data.payload]);
            } else if (data.type === 'candidate-info') {
                setCandidateName(data.payload.name);
                setCandidateInfo(data.payload);
                toast.info(`Candidate joined: ${data.payload.name}`);
            }
        });
        conn.on('error', (err) => console.error("[Data] Error:", err));
    }, []);

    const connectToHost = useCallback((peer: Peer, stream: MediaStream) => {
        if (!peer || peer.destroyed) return;
        console.log(`[WebRTC] Calling: ${targetPeerId}`);
        const call = peer.call(targetPeerId, stream);
        callRef.current = call;
        if (call) {
            call.on('stream', (remoteStream) => {
                console.log("[WebRTC] Remote Stream Received");
                remoteStreamRef.current = remoteStream;
                setIsConnected(true);
            });
        }
        const conn = peer.connect(targetPeerId);
        handleConnection(conn);

        // If candidate, send info as soon as connection is established (delay slightly to ensures open)
        if (!isInterviewer) {
            setTimeout(() => {
                if (connInstance.current && connInstance.current.open) {
                    connInstance.current.send({
                        type: 'candidate-info',
                        payload: {
                            ...candidateInfo,
                            name: candidateName || candidateInfo?.fullName || 'Candidate',
                            email: candidateInfo?.email || localStorage.getItem('userEmail') || 'candidate@example.com'
                        }
                    });
                }
            }, 2000); // Wait for connection to stabilize
        }
    }, [targetPeerId, handleConnection, isInterviewer, candidateName, candidateInfo]);

    // --- LifeCycle ---
    useEffect(() => {
        const init = async () => {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
                    .catch(() => navigator.mediaDevices.getUserMedia({ audio: true }));

                streamRef.current = stream;
                if (myVideoRef.current) myVideoRef.current.srcObject = stream;

                try { startTranscription(); } catch (e) { console.error(e); }

                const peer = new Peer(myId, {
                    debug: 1,
                    config: {
                        iceServers: [
                            { urls: 'stun:stun.l.google.com:19302' },
                            { urls: 'stun:stun1.l.google.com:19302' },
                        ]
                    }
                });
                peerInstance.current = peer;

                peer.on('open', (id) => {
                    setMyPeerId(id);
                    console.log(`[Peer] Open with ID: ${id}`);
                });

                peer.on('call', (call) => {
                    callRef.current = call;
                    call.answer(stream);
                    call.on('stream', (remoteStream) => {
                        remoteStreamRef.current = remoteStream;
                        setIsConnected(true);
                        toast.success("Connected to Candidate!");
                    });
                });

                if (!isInterviewer) {
                    console.log("[Student] Scheduling connection attempt...");
                    setTimeout(() => connectToHost(peer, stream), 2000);

                    // Fetch profile info for sync
                    const email = localStorage.getItem('userEmail');
                    if (email) {
                        try {
                            const resp = await fetch(`${API_BASE_URL}/student/me/${email}`);
                            if (resp.ok) {
                                const data = await resp.json();
                                setCandidateName(data.fullName || data.name || 'Candidate');
                                setCandidateInfo(data);
                            }
                        } catch (e) { console.error("Could not fetch student info", e); }
                    }
                }

                peer.on('connection', (conn) => {
                    handleConnection(conn);
                    // If interviewer, wait for info
                });

                // Send info when conn opens if I'm candidate and someone connects to me (unlikely in this flow but safe)
                // Handled in connectToHost mostly.

                peer.on('error', (err) => {
                    console.error("[Peer] Error:", err.type);
                    if (err.type === 'unavailable-id') toast.error("Session conflict. Please refresh.");
                });



            } catch (err) {
                toast.error("Camera/Mic Denied");
            }
        };

        init();

        return () => {
            if (peerInstance.current) peerInstance.current.destroy();
            if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
            if (mediaRecorderRef.current) mediaRecorderRef.current.stop();
        };
    }, []);

    // Actions
    const toggleMic = () => {
        const track = streamRef.current?.getAudioTracks()[0];
        if (track) {
            track.enabled = !track.enabled;
            setIsMicOn(track.enabled);
            // Also toggle transcription to save resources / prevent errors
            if (track.enabled) startTranscription();
            else stopTranscription();
        }
    };
    const toggleVideo = () => {
        const track = streamRef.current?.getVideoTracks()[0];
        if (track) { track.enabled = !track.enabled; setIsVideoOn(track.enabled); }
    };

    // Replace the outgoing video track in the Peer connection and local stream
    const replaceOutgoingVideoTrack = async (newTrack: MediaStreamTrack) => {
        try {
            // Update local stream
            if (streamRef.current) {
                // Remove existing video tracks
                streamRef.current.getVideoTracks().forEach(t => streamRef.current?.removeTrack(t));
                streamRef.current.addTrack(newTrack);
                if (myVideoRef.current) myVideoRef.current.srcObject = streamRef.current;
            }

            // Replace track on peer connection sender
            const pc = callRef.current?.peerConnection;
            if (pc && typeof pc.getSenders === 'function') {
                const sender = pc.getSenders().find((s: any) => s.track && s.track.kind === 'video');
                if (sender) {
                    await sender.replaceTrack(newTrack);
                }
            }
        } catch (e) { console.error('Replace track failed', e); }
    };

    const startScreenShare = async () => {
        try {
            const screenStream = await (navigator.mediaDevices as any).getDisplayMedia({ video: true });
            const screenTrack = screenStream.getVideoTracks()[0];
            if (!screenTrack) throw new Error('No screen track');

            // When the user stops sharing via browser UI, revert
            screenTrack.onended = () => {
                stopScreenShare();
            };

            screenStreamRef.current = screenStream;
            await replaceOutgoingVideoTrack(screenTrack);
            setIsScreenSharing(true);
            setIsVideoOn(true);
            addDebug('Screen sharing started');
        } catch (e) {
            console.error('Screen share error', e);
            toast.error('Could not start screen share');
        }
    };

    const stopScreenShare = async () => {
        try {
            // Stop any existing screen tracks
            screenStreamRef.current?.getTracks().forEach(t => t.stop());
            screenStreamRef.current = null;

            // Try to re-acquire camera video and replace track
            const camStream = await navigator.mediaDevices.getUserMedia({ video: true }).catch(() => null);
            const camTrack = camStream?.getVideoTracks()[0];
            if (camTrack) {
                await replaceOutgoingVideoTrack(camTrack);
                setIsVideoOn(true);
                addDebug('Screen sharing stopped — returned to camera');
            } else {
                // If camera unavailable, remove video track
                if (streamRef.current) streamRef.current.getVideoTracks().forEach(t => t.stop());
                setIsVideoOn(false);
            }
        } catch (e) {
            console.error('Stop screen share failed', e);
        } finally {
            setIsScreenSharing(false);
        }
    };
    const handleManualRetry = () => {
        if (peerInstance.current && streamRef.current) connectToHost(peerInstance.current, streamRef.current);
    };

    const copyInviteLink = () => {
        const url = window.location.origin + `/hr-interview-panel?session=${SESSION_ID}&role=candidate`;
        navigator.clipboard.writeText(url);
        toast.success("Invite link copied!");
    };

    const endCall = () => navigate(isInterviewer ? '/company/dashboard' : '/student/dashboard');

    const handleStartInterview = () => {
        setInterviewStartTime(new Date());
        setIsInterviewActive(true);
        toast.info("Interview Started");
    };

    const handleEndInterview = async () => {
        if (isSaving) return;
        setIsInterviewActive(false);
        await handleSaveNotes();
        toast.success("Interview Ended and Results Saved");
        setTimeout(() => navigate('/company/dashboard'), 2000);
    };

    const handleSaveNotes = async () => {
        setIsSaving(true);
        try {
            const hrEmail = companyData?.hrEmail || localStorage.getItem('userEmail') || 'hr@mockello.com';
            const candidateId = candidateInfo?.email || 'GuestCandidate';

            console.log("[SaveNotes] Payload:", {
                company_email: hrEmail,
                candidate_id: candidateId,
                notes,
                decision,
                timestamp: new Date().toISOString()
            });

            const resp = await fetch(`${API_BASE_URL}/company/interview-result`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    company_email: hrEmail,
                    candidate_id: candidateId,
                    notes: notes || "No notes provided",
                    decision: decision || "Hold",
                    timestamp: new Date().toISOString()
                })
            });

            if (resp.ok) {
                toast.success("Interview Results Saved Successfully");
            } else {
                const err = await resp.text();
                console.error("[SaveNotes] Backend Error:", err);
                toast.error("Failed to save results to database");
            }
        } catch (e) {
            console.error("[SaveNotes] Network Error:", e);
            toast.error("Network error saving results");
        } finally {
            setIsSaving(false);
        }
    };

    const TranscriptionBox = ({ isDark = false }) => (
        <div className={`flex flex-col h-full overflow-hidden ${isDark ? 'text-white' : 'text-slate-800'}`}>
            <div className={`p-4 border-b ${isDark ? 'border-white/10' : 'bg-slate-50'} flex justify-between`}>
                <span className="text-xs font-bold uppercase tracking-widest flex items-center gap-2">
                    <MessageSquare size={14} /> Transcript
                </span>
                <div className="flex items-center gap-2">
                    {isTranscribing ? (
                        <span className="text-[10px] animate-pulse text-emerald-400 font-bold uppercase tracking-widest flex items-center gap-1">
                            <span className="w-2 h-2 rounded-full bg-emerald-400"></span> Live
                        </span>
                    ) : (
                        <span className="text-[10px] text-slate-400 font-bold uppercase tracking-widest flex items-center gap-1">
                            <span className="w-2 h-2 rounded-full bg-slate-400"></span> Off
                        </span>
                    )}
                    <Button variant="ghost" size="icon" className="h-6 w-6 ml-2" onClick={isTranscribing ? stopTranscription : startTranscription} title={isTranscribing ? "Stop Captioning" : "Start Captioning"}>
                        {isTranscribing ? <Volume2 size={12} className="text-emerald-400" /> : <Volume2 size={12} className="opacity-40" />}
                    </Button>
                </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-hide">
                {transcripts.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center opacity-20 text-xs italic gap-2">
                        <MessageSquare size={24} />
                        <span>Waiting for speech...</span>
                    </div>
                ) : (
                    <>
                        {transcripts.map((t, i) => (
                            <div key={i} className={`flex flex-col ${t.speaker === (isInterviewer ? 'HR' : 'Candidate') ? 'items-end' : 'items-start'}`}>
                                <span className="text-[9px] font-bold uppercase opacity-40 mb-1">{t.speaker}</span>
                                <div className={`px-4 py-2 rounded-2xl text-[11px] max-w-[85%] ${t.speaker === 'HR' ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-900/20' : (isDark ? 'bg-white/10' : 'bg-white border shadow-sm')
                                    }`}>
                                    {t.text}
                                </div>
                            </div>
                        ))}
                        {isProcessing && (
                            <div className="flex items-start gap-2 opacity-50">
                                <span className="text-[9px] font-bold uppercase opacity-40">...</span>
                                <div className="px-3 py-1 rounded-full bg-slate-100 dark:bg-white/5 text-[9px]">Transcribing...</div>
                            </div>
                        )}
                    </>
                )}
                <div ref={transcriptEndRef} />
            </div>
        </div>
    );

    if (!isInterviewer) {
        return (
            <div className="h-screen bg-[#112620] text-white flex overflow-hidden font-sans">
                <div className="flex-1 flex flex-col relative p-6">
                    <div className="flex-1 bg-[#1a3a32] rounded-[32px] border border-white/5 relative overflow-hidden flex items-center justify-center">
                        {!isConnected ? (
                            <div className="flex flex-col items-center gap-4 text-white/30">
                                <RefreshCw className="w-12 h-12 animate-spin opacity-20" />
                                <span className="text-[10px] font-bold uppercase tracking-widest">Waiting for HR...</span>
                                <Button size="sm" variant="outline" className="mt-2 border-white/10 text-white/60 hover:bg-white/5" onClick={handleManualRetry}>Connect Now</Button>
                            </div>
                        ) : (
                            <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-cover" />
                        )}
                        {isConnected && <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-black/40 backdrop-blur px-6 py-2 rounded-full border border-white/5 text-xs font-bold uppercase tracking-widest">Interviewer (Connected)</div>}
                    </div>
                    <div className="absolute top-10 right-10 w-64 aspect-video bg-[#0d1f1b] rounded-24px border border-white/10 overflow-hidden shadow-2xl z-20">
                        <video ref={myVideoRef} autoPlay playsInline muted className="w-full h-full object-cover transform scale-x-[-1]" />
                        {!isVideoOn && <div className="absolute inset-0 bg-[#0d1f1b] flex items-center justify-center"><VideoOff className="opacity-20" /></div>}
                    </div>
                    <div className="h-24 flex items-center justify-center gap-4 mt-4">
                        <Button variant="outline" size="icon" onClick={toggleMic} className={`rounded-xl w-12 h-12 bg-white/5 border-white/10 hover:bg-white/10 ${!isMicOn && 'bg-red-500/80 text-white'}`}>
                            {isMicOn ? <Mic size={20} /> : <MicOff size={20} />}
                        </Button>
                        <Button variant="outline" size="icon" onClick={toggleVideo} className={`rounded-xl w-12 h-12 bg-white/5 border-white/10 hover:bg-white/10 ${!isVideoOn && 'bg-red-500/80 text-white'}`}>
                            {isVideoOn ? <Video size={20} /> : <VideoOff size={20} />}
                        </Button>
                        <Button variant="outline" size="icon" onClick={isScreenSharing ? stopScreenShare : startScreenShare} className={`rounded-xl w-12 h-12 bg-white/5 border-white/10 hover:bg-white/10 ${isScreenSharing ? 'bg-emerald-600 text-white' : ''}`} title={isScreenSharing ? 'Stop Screen Share' : 'Share Screen'}>
                            <Video size={18} />
                        </Button>
                        <Button variant="destructive" onClick={endCall} className="h-12 px-10 rounded-xl font-bold uppercase tracking-widest shadow-xl">Leave</Button>
                    </div>
                </div>
                <div className="w-[380px] bg-[#0d1f1b] border-l border-white/5 flex flex-col shadow-2xl">
                    <TranscriptionBox isDark={true} />
                    <div className="absolute top-4 left-4 z-50">
                        <Button size="sm" variant={isTranscribing ? "default" : "secondary"} className="h-8 text-[10px] uppercase font-bold tracking-widest" onClick={isTranscribing ? stopTranscription : startTranscription}>
                            {isTranscribing ? "Captions On" : "Captions Off"}
                        </Button>
                    </div>
                </div>
            </div>
        );
    }


    return (
        <div className="h-screen bg-[#f4fbf7] text-slate-800 flex flex-col overflow-hidden font-sans">
            {/* Header */}
            <header className="h-16 bg-gradient-to-r from-[#e9f6ef] to-[#f6fbf8] border-b border-[#e0f0e6] flex items-center justify-between px-8 shadow-sm z-10">
                <div className="flex items-center gap-6 flex-1">
                    <div>
                        <h1 className="text-lg font-bold text-[#14442f]">HR Interview Panel</h1>
                        <p className="text-xs text-[#3b6b55] mt-0.5">{candidateName} | Software Engineer | Session ID: {SESSION_ID}</p>
                    </div>
                </div>
                <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2 px-3 py-1.5 bg-white rounded-full border border-[#d6efe0] shadow-sm">
                        <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'}`}></div>
                        <span className="text-[11px] font-bold text-slate-600 uppercase tracking-tight">
                            {isConnected ? 'Candidate Connected' : 'Waiting for Candidate'}
                        </span>
                    </div>
                    <Button
                        size="sm"
                        className={`${isInterviewActive ? 'bg-red-500 hover:bg-red-600' : 'bg-[#15543b] hover:bg-[#11412d]'} text-white font-bold text-xs px-6 rounded-lg transition-all shadow-md`}
                        onClick={isInterviewActive ? handleEndInterview : handleStartInterview}
                    >
                        {isInterviewActive ? 'Stop Session' : 'Start Interview'}
                    </Button>
                    <Button size="sm" variant="ghost" className="text-[#145032] hover:bg-white/50">Debug</Button>
                </div>
            </header>

            {/* Main Content */}
            <div className="flex-1 flex overflow-hidden">
                {/* Left Sidebar - Candidate Profile */}
                <div className="w-96 bg-[#eaf6ef] border-r border-[#d6efe0] p-6 flex flex-col gap-6 overflow-y-auto rounded-tr-2xl rounded-br-2xl">
                    <div className="flex flex-col items-center">
                        <div className="w-20 h-20 rounded-full bg-[#15543b] flex items-center justify-center text-white text-2xl font-bold mb-4 border-4 border-white shadow-md">
                            {candidateName.charAt(0)}
                        </div>
                        <h3 className="text-base font-bold text-slate-900">{candidateName}</h3>
                        <p className="text-xs text-[#3b6b55] font-medium">{candidateInfo?.email || 'Candidate Email'}</p>
                    </div>

                    <div className="space-y-4">
                        {/* Education Section */}
                        <div className="bg-white/60 rounded-xl p-4 border border-[#e6efe9] shadow-sm">
                            <h4 className="text-[10px] font-bold uppercase text-slate-400 mb-2 flex items-center gap-1.5">
                                <Users size={12} /> Education
                            </h4>
                            <div className="space-y-1">
                                <p className="text-xs font-bold text-slate-800">{candidateInfo?.degree || 'Degree'} - {candidateInfo?.branch || 'Branch'}</p>
                                <p className="text-[11px] text-slate-600 font-medium">{candidateInfo?.collegeName || 'Institution name not available'}</p>
                                <div className="mt-2 flex items-center justify-between">
                                    <span className="text-[10px] text-slate-500">Graduation Year: {candidateInfo?.yearOfPassing || 'N/A'}</span>
                                    <span className="text-[11px] text-emerald-600 font-bold bg-emerald-50 px-2 py-0.5 rounded">CGPA: {candidateInfo?.cgpa || 'N/A'}</span>
                                </div>
                            </div>
                        </div>

                        {/* Skills Section */}
                        <div className="bg-white/60 rounded-xl p-4 border border-[#e6efe9] shadow-sm">
                            <h4 className="text-[10px] font-bold uppercase text-slate-400 mb-2 flex items-center gap-1.5">
                                <Settings size={12} /> Technical Skills
                            </h4>
                            <div className="flex flex-wrap gap-1.5">
                                {(candidateInfo?.skills || 'Communication, Problem Solving').split(',').map((skill: string, i: number) => (
                                    <span key={i} className="px-2 py-0.5 bg-[#eaf6ef] text-[#15543b] rounded text-[10px] font-semibold border border-[#d6efe0]">
                                        {skill.trim()}
                                    </span>
                                ))}
                            </div>
                        </div>

                        {/* Experience Section */}
                        <div className="bg-white/60 rounded-xl p-4 border border-[#e6efe9] shadow-sm">
                            <h4 className="text-[10px] font-bold uppercase text-slate-400 mb-2 flex items-center gap-1.5">
                                <FileText size={12} /> Experience / Internships
                            </h4>
                            <p className="text-[11px] text-slate-600 leading-relaxed italic">
                                {candidateInfo?.internshipExperience || 'No internship experience listed.'}
                            </p>
                        </div>

                        {/* Additional Info */}
                        <div className="bg-white/60 rounded-xl p-4 border border-[#e6efe9] shadow-sm">
                            <h4 className="text-[10px] font-bold uppercase text-slate-400 mb-2">Identification</h4>
                            <div className="grid grid-cols-2 gap-2 text-[10px]">
                                <div>
                                    <p className="text-slate-400 uppercase font-bold">Register No</p>
                                    <p className="text-slate-700 font-medium">{candidateInfo?.registerNumber || 'N/A'}</p>
                                </div>
                                <div>
                                    <p className="text-slate-400 uppercase font-bold">Contact</p>
                                    <p className="text-slate-700 font-medium">{candidateInfo?.mobileNumber || 'N/A'}</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Center - Video Area */}
                <div className="flex-1 bg-transparent p-6 flex flex-col relative overflow-hidden">
                    <div className="flex-1 bg-white rounded-3xl border-2 border-[#e6efe9] overflow-hidden relative flex items-center justify-center shadow-md">
                        {!isConnected ? (
                            <div className="flex flex-col items-center gap-4 text-slate-400">
                                <div className="p-4 bg-emerald-50 rounded-full">
                                    <RefreshCw className="w-10 h-10 animate-spin text-emerald-600" />
                                </div>
                                <div className="text-center">
                                    <p className="text-sm font-bold text-slate-700">Waiting for Candidate</p>
                                    <p className="text-xs text-slate-500 mt-1">Session Protocol: {SESSION_ID}</p>
                                </div>
                                <div className="flex gap-2 mt-2">
                                    <Button size="sm" variant="outline" onClick={handleManualRetry} className="h-8 text-xs font-bold border-emerald-200 text-emerald-700 hover:bg-emerald-50">
                                        Manual Connect
                                    </Button>
                                    <Button size="sm" variant="secondary" onClick={copyInviteLink} className="h-8 text-xs font-bold bg-white border shadow-sm">
                                        Copy Link
                                    </Button>
                                </div>
                            </div>
                        ) : (
                            <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-cover" />
                        )}

                        {/* Status Overlays */}
                        <div className="absolute top-4 left-4 flex gap-2">
                            <div className="px-3 py-1 bg-emerald-500 text-white rounded-full text-[10px] font-bold uppercase tracking-wider shadow-sm uppercase">HD Live</div>
                            {isTranscribing && <div className="px-3 py-1 bg-amber-500 text-white rounded-full text-[10px] font-bold uppercase tracking-wider shadow-sm flex items-center gap-1.5">
                                <div className="w-1.5 h-1.5 bg-white rounded-full animate-pulse"></div> Captions Active
                            </div>}
                        </div>

                        {/* Picture-in-Picture (Interviewer) */}
                        <div className="absolute bottom-6 left-6 w-48 aspect-video bg-white rounded-xl border-2 border-[#e6efe9] flex items-center justify-center text-xs text-[#37624a] font-semibold overflow-hidden shadow-2xl z-20">
                            <video ref={myVideoRef} autoPlay playsInline muted className="w-full h-full object-cover transform scale-x-[-1]" />
                            <div className="absolute bottom-2 right-2 bg-black/40 backdrop-blur px-2 py-0.5 rounded text-[9px] font-bold text-white uppercase tracking-wider">Interviewer</div>
                        </div>
                    </div>

                    {/* Media Controls */}
                    <div className="mt-6 flex items-center justify-center gap-4">
                        <Button variant="outline" size="icon" onClick={toggleMic} className={`w-12 h-12 rounded-2xl shadow-sm transition-all ${!isMicOn ? 'bg-red-500 text-white border-red-500 hover:bg-red-600' : 'bg-white hover:bg-slate-50'}`}>
                            {isMicOn ? <Mic size={20} /> : <MicOff size={20} />}
                        </Button>
                        <Button variant="outline" size="icon" onClick={toggleVideo} className={`w-12 h-12 rounded-2xl shadow-sm transition-all ${!isVideoOn ? 'bg-red-500 text-white border-red-500 hover:bg-red-600' : 'bg-white hover:bg-slate-50'}`}>
                            {isVideoOn ? <Video size={20} /> : <VideoOff size={20} />}
                        </Button>
                        <Button
                            variant="outline"
                            size="icon"
                            onClick={isScreenSharing ? stopScreenShare : startScreenShare}
                            className={`w-12 h-12 rounded-2xl shadow-sm transition-all ${isScreenSharing ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white hover:bg-slate-50'}`}
                            title={isScreenSharing ? 'Stop Screen Share' : 'Share Screen'}
                        >
                            <Signal size={20} />
                        </Button>
                        <div className="w-px h-8 bg-slate-200 mx-2"></div>
                        <Button variant="destructive" onClick={handleEndInterview} className="h-12 px-8 rounded-2xl font-bold uppercase tracking-widest shadow-lg">
                            End Interview
                        </Button>
                    </div>
                </div>

                {/* Right Sidebar - Transcript & Notes */}
                <div className="w-80 bg-[#eaf6ef] border-l border-[#d6efe0] flex flex-col p-6 gap-6 overflow-y-auto rounded-tl-2xl rounded-bl-2xl">
                    {/* Real-time Transcription */}
                    <div className="h-[350px] bg-white rounded-xl border border-[#e6efe9] overflow-hidden shadow-sm flex flex-col shrink-0">
                        <TranscriptionBox isDark={false} />
                    </div>

                    {/* Interview Notes */}
                    <div className="flex-1 flex flex-col">
                        <div className="flex items-center justify-between mb-3">
                            <h3 className="font-bold text-sm text-slate-900">HR Interview Notes</h3>
                            <span className="text-xs text-emerald-600 font-semibold bg-emerald-50 px-2 py-0.5 rounded">Active</span>
                        </div>

                        <div className="mb-4">
                            <label className="text-[10px] font-bold uppercase text-slate-500 mb-1 block">Quick Decision</label>
                            <select
                                value={decision}
                                onChange={(e) => setDecision(e.target.value)}
                                className="w-full p-2.5 text-xs border border-[#e6efe9] rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-[#15543b]/20 focus:border-[#15543b] transition-all"
                            >
                                <option value="Hold">On Hold</option>
                                <option value="Hire">Recommend Hire</option>
                                <option value="Reject">Reject</option>
                            </select>
                        </div>

                        <Textarea
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            className="flex-1 resize-none border border-[#e6efe9] rounded-xl p-3 text-xs leading-relaxed focus:ring-2 focus:ring-[#15543b]/20 focus:border-[#15543b] focus:outline-none bg-white font-sans"
                            placeholder="Type observations about communication, technical grounding, behavioral fit..."
                        />

                        <Button
                            variant="outline"
                            className="mt-4 w-full text-xs font-bold rounded-xl border-[#d7efe0] bg-white hover:bg-[#eaf6ef] text-[#15543b] h-10 shadow-sm"
                            onClick={handleSaveNotes}
                            disabled={isSaving}
                        >
                            {isSaving ? 'Syncing...' : 'Save Draft Notes'}
                        </Button>
                    </div>
                </div>
            </div>

            {/* Bottom Bar (Timer & Main Action) */}
            <div className="h-16 bg-white border-t border-[#e0f0e6] flex items-center justify-between px-8 z-10 shadow-[0_-2px_10px_rgba(0,0,0,0.02)]">
                <div className="flex items-center gap-6">
                    <div className="flex flex-col">
                        <span className="text-[10px] font-bold uppercase text-slate-400">Interview Duration</span>
                        <span className="text-sm font-mono font-bold text-[#145032]">{elapsedTime}</span>
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    <Button
                        variant="default"
                        className="text-sm font-bold h-10 px-8 rounded-xl bg-[#15543b] hover:bg-[#0e3a29] text-white shadow-md transition-all active:scale-95"
                        onClick={handleSaveNotes}
                        disabled={isSaving}
                    >
                        {isSaving ? 'Saving...' : 'Mark Interview Completed'}
                    </Button>
                </div>
            </div>
        </div>
    );
};

export default HRInterviewPortal;
