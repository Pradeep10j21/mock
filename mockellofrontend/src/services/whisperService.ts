import { toast } from 'sonner';
import { API_BASE_URL } from './apiConfig';

export const whisperService = {
    // Transcribe audio using our backend (which uses Groq/Whisper)
    transcribeAudio: async (audioBlob: Blob): Promise<string> => {
        const formData = new FormData();

        // Better extension mapping based on MIME type
        let ext = 'webm';
        if (audioBlob.type.includes('wav')) ext = 'wav';
        else if (audioBlob.type.includes('mp4')) ext = 'mp4';
        else if (audioBlob.type.includes('mpeg')) ext = 'mp3';
        else if (audioBlob.type.includes('ogg')) ext = 'ogg';

        formData.append('file', audioBlob, `audio.${ext}`);

        try {
            console.log(`[WhisperService] Sending to Backend: ${audioBlob.size} bytes, mime: ${audioBlob.type}`);
            const response = await fetch(`${API_BASE_URL}/ai-interviewer/transcribe`, {
                method: 'POST',
                body: formData,
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`[WhisperService] Backend Error (${response.status}):`, errorText);
                toast.error("Transcription service temporarily unavailable");
                return '';
            }

            const data = await response.json();
            console.log(`[WhisperService] Success: "${data.text?.substring(0, 50)}..."`);
            return data.text || '';
        } catch (error) {
            console.error("[WhisperService] Fetch Error:", error);
            return '';
        }
    },
};
