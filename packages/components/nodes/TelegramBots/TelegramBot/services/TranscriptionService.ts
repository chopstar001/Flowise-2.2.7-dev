// packages/components/nodes/TelegramBots/TelegramBot/services/TranscriptionService.ts
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import axios from 'axios';
import {
    TranscriptionProvider,
    TranscriptionOptions,
    TranscriptionEstimate
} from '../commands/types'; // Assuming types are correctly defined here

const execAsync = promisify(exec);

// Define supported extensions
export const SUPPORTED_AUDIO_EXTENSIONS = ['.wav', '.mp3', '.ogg', '.flac', '.m4a', '.aac'];
export const SUPPORTED_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
// Add common document types if needed later, for now just media
// const SUPPORTED_DOCUMENT_EXTENSIONS = ['.pdf', '.docx', '.txt'];
export const SUPPORTED_MEDIA_EXTENSIONS = [...SUPPORTED_AUDIO_EXTENSIONS, ...SUPPORTED_VIDEO_EXTENSIONS];


export class TranscriptionService {
    private defaultProvider: TranscriptionProvider = 'local-cuda';
    private modelPath: string;
    private whisperPath: string;
    private apiKeys: Record<string, string> = {};
    public readonly inputFolderPath: string; // Folder to watch for manual drops - MAKE PUBLIC READONLY
    private processedFolderPath: string; // Folder to move processed files
    private transcriptOutputFolderPath: string; // Folder specifically for .txt transcripts
    // Removed duplicate declaration

    constructor(config: {
        defaultProvider?: TranscriptionProvider;
        modelPath?: string;
        whisperPath?: string;
        apiKeys?: Record<string, string>;
    } = {}) {
        this.defaultProvider = config.defaultProvider || 'local-cuda';
        this.modelPath = config.modelPath || path.join(process.cwd(), 'models');
        this.whisperPath = config.whisperPath || '/usr/bin/whisper'; // Ensure this path is correct for your system
        this.apiKeys = config.apiKeys || {};

        // Define input and processed folder paths relative to this service file's directory
        const baseDir = path.dirname(__dirname); // Gets the TelegramBot directory (e.g., .../TelegramBot)
        this.inputFolderPath = path.join(baseDir, 'transcribe_input');
        this.processedFolderPath = path.join(this.inputFolderPath, 'processed');
        this.transcriptOutputFolderPath = path.join(this.processedFolderPath, 'transcripts'); // Subfolder for transcripts

        // Create necessary directories if they don't exist
        [this.modelPath, this.inputFolderPath, this.processedFolderPath, this.transcriptOutputFolderPath].forEach(dirPath => {
            if (!fs.existsSync(dirPath)) {
                try {
                    fs.mkdirSync(dirPath, { recursive: true });
                    console.log(`Created directory: ${dirPath}`);
                } catch (mkdirError) {
                    console.error(`Failed to create directory ${dirPath}:`, mkdirError);
                    // Depending on severity, you might want to throw an error here
                }
            }
        });

        // --> ADD CHECK FOR WHISPER EXECUTABLE <--
        if (!fs.existsSync(this.whisperPath)) {
             console.error(`CRITICAL: Whisper executable not found at configured path: ${this.whisperPath}`);
             console.error(`Please ensure Whisper is installed and the path is correct in TranscriptionService constructor.`);
             // Optionally, throw an error to halt initialization completely:
             // throw new Error(`Whisper executable not found at ${this.whisperPath}`);
        } else {
             console.log(`Whisper executable found at: ${this.whisperPath}`);
        }
        // --> END CHECK <--

        this.initializeProviderCheck();
    }

    private async initializeProviderCheck(): Promise<void> {
         // Check if CUDA is actually available for PyTorch
         try {
            const cudaAvailable = await this.checkCudaAvailability();
            if (cudaAvailable) {
                console.log('CUDA is available for PyTorch - using GPU acceleration');
                // Keep default or config preference if CUDA is available
                this.defaultProvider = this.defaultProvider === 'local-cpu' ? 'local-cuda' : this.defaultProvider; // Prefer CUDA if available
            } else {
                console.log('CUDA is not available for PyTorch - using CPU only');
                // Force CPU if CUDA check fails, regardless of config
                this.defaultProvider = 'local-cpu';
            }
        } catch (error) {
            console.warn('Error checking CUDA availability:', error);
            this.defaultProvider = 'local-cpu'; // Fallback to CPU on error
            console.log('TranscriptionService defaulting to CPU provider due to CUDA check error');
        } finally {
             // Log available providers after check completes or fails
            const availableProviders = new Set<string>();
            availableProviders.add(this.defaultProvider); // Add the determined default

            // Always add CPU as an option if local is possible
            if (this.defaultProvider.startsWith('local-')) {
                 availableProviders.add('local-cpu');
            }

            if (this.apiKeys['assemblyai']?.length > 0) {
                availableProviders.add('assemblyai');
            }
            if (this.apiKeys['google']?.length > 0) {
                availableProviders.add('google');
            }
            console.log(`TranscriptionService initialized. Default: ${this.defaultProvider}. Available: ${Array.from(availableProviders).join(', ')}`);
        }
    }

    private async checkCudaAvailability(): Promise<boolean> {
        try {
            const tempDir = path.join(os.tmpdir(), `flowise-cuda-check-${Date.now()}`);
            fs.mkdirSync(tempDir, { recursive: true });
            const scriptPath = path.join(tempDir, 'cuda_check.py');
            const script = `
import torch
import sys
import os
try:
    cuda_available = torch.cuda.is_available()
    print(f"CUDA available: {cuda_available}")
    if cuda_available:
        print(f"CUDA device count: {torch.cuda.device_count()}")
        print(f"CUDA device name: {torch.cuda.get_device_name(0)}")
        print(f"CUDA version: {torch.version.cuda}")
    else:
        # Check environment variables that might indicate CUDA presence even if torch fails
        cuda_visible = os.environ.get('CUDA_VISIBLE_DEVICES', 'Not Set')
        nvidia_smi_path = os.environ.get('NVIDIA_SMI_PATH', '/usr/bin/nvidia-smi') # Common path
        print(f"CUDA_VISIBLE_DEVICES: {cuda_visible}")
        # Optionally try running nvidia-smi if path exists
        # if os.path.exists(nvidia_smi_path):
        #    print("Attempting nvidia-smi check...")
        #    os.system(f"{nvidia_smi_path}") # Be cautious with os.system
    sys.exit(0 if cuda_available else 1)
except Exception as e:
    print(f"Error during CUDA check: {e}")
    sys.exit(1)
finally:
    # Clean up the script file
    if os.path.exists("${scriptPath.replace(/\\/g, '\\\\')}"): # Escape backslashes for Python string
        os.remove("${scriptPath.replace(/\\/g, '\\\\')}")
    # Optionally remove the directory if empty - might fail if other processes use it
    # try:
    #     os.rmdir("${tempDir.replace(/\\/g, '\\\\')}")
    # except OSError:
    #     pass # Ignore if not empty or other error
`;
            fs.writeFileSync(scriptPath, script);

            const { stdout, stderr } = await execAsync(`python3 "${scriptPath}"`);
            console.log(`CUDA check stdout:\n${stdout.trim()}`);
             if (stderr && stderr.trim()) {
                console.warn(`CUDA check stderr:\n${stderr.trim()}`);
            }

            // No need to manually delete script here, Python script does it in finally block
            try { fs.rmdirSync(tempDir); } catch (_) { /* Ignore cleanup error */ }

            return stdout.includes("CUDA available: True");

        } catch (error) {
            console.warn('CUDA availability check command failed:', error.message || error);
             if (error.stdout) console.warn('CUDA check failed stdout:', error.stdout);
             if (error.stderr) console.warn('CUDA check failed stderr:', error.stderr);
            return false;
        }
    }

    public async transcribe(
        audioPath: string,
        options: TranscriptionOptions = {}
    ): Promise<string> {
        const provider = options.provider || this.defaultProvider;
        const modelSize = options.modelSize || 'medium';
        const outputDirectory = options.outputDirectory || path.dirname(audioPath);

        console.log(`Transcribing audio using ${provider} provider with ${modelSize} model. Output dir: ${outputDirectory}`);

        if (provider.startsWith('local-') && !fs.existsSync(outputDirectory)) {
             try {
                fs.mkdirSync(outputDirectory, { recursive: true });
                console.log(`Created output directory: ${outputDirectory}`);
            } catch (mkdirError) {
                 console.error(`Failed to create output directory ${outputDirectory}:`, mkdirError);
                 throw new Error(`Failed to create output directory: ${mkdirError.message}`);
            }
        }

        switch (provider) {
            case 'local-cuda':
                return this.transcribeWithLocal(audioPath, modelSize, options, outputDirectory, true);
            case 'local-cpu':
                return this.transcribeWithLocal(audioPath, modelSize, options, outputDirectory, false);
            case 'assemblyai':
                return this.transcribeWithAssemblyAI(audioPath, options);
            case 'google':
                return this.transcribeWithGoogle(audioPath, options);
            default:
                throw new Error(`Unsupported transcription provider: ${provider}`);
        }
    }

    private async transcribeWithLocal(
        audioPath: string,
        modelSize: string = 'medium',
        options: TranscriptionOptions = {},
        outputDirectory: string,
        useCuda: boolean
    ): Promise<string> {
        const providerLabel = useCuda ? 'CUDA' : 'CPU';
        let cmd = ''; // Define cmd here to include it in the error message
        try {
            console.log(`Starting transcription with local ${providerLabel} for file: ${audioPath}`);

            if (!fs.existsSync(audioPath)) {
                throw new Error(`Audio file not found: ${audioPath}`);
            }
            console.log(`Verified audio file exists: ${audioPath}`);

            let deviceFlag = '';
            if (useCuda) {
                // Rely on the initial check, but log intent
                if (this.defaultProvider === 'local-cuda') {
                     deviceFlag = '--device cuda';
                     console.log('Attempting transcription with CUDA device.');
                } else {
                    console.warn('CUDA was requested, but initial check failed or default is CPU. Using CPU.');
                }
            }

            const langParam = options.language && options.language !== 'auto' ?
                `--language ${options.language}` : '--language en';

             if (!fs.existsSync(outputDirectory)) {
                 try {
                    fs.mkdirSync(outputDirectory, { recursive: true });
                    console.log(`Created specific output directory: ${outputDirectory}`);
                 } catch (mkdirError) {
                     console.error(`Failed to create output directory ${outputDirectory}:`, mkdirError);
                     throw new Error(`Failed to create output directory: ${mkdirError.message}`);
                 }
            }

            cmd = `"${this.whisperPath}" "${audioPath}" --model ${modelSize} ${deviceFlag} ${langParam} --output_dir "${outputDirectory}" --output_format txt`;
            console.log(`Executing Whisper command: ${cmd}`);

            const { stdout, stderr } = await execAsync(cmd, { maxBuffer: 1024 * 1024 * 50 });

            if (stderr && stderr.trim()) {
                const filteredStderr = stderr.split('\n').filter(line =>
                    !line.includes('Processing') &&
                    !line.includes('Detected language:') &&
                    !line.match(/(\d+(\.\d+)?(s|ms|m|h))+/) // Filter out timing lines
                ).join('\n');
                 if (filteredStderr.trim()) {
                    console.warn(`Warnings/messages from Whisper (${providerLabel}):\n${filteredStderr.trim()}`);
                 }
            }

            const baseName = path.basename(audioPath, path.extname(audioPath));
            const expectedOutputFile = path.join(outputDirectory, `${baseName}.txt`);
            console.log(`Checking for output file: ${expectedOutputFile}`);

            let transcription = '';
            if (fs.existsSync(expectedOutputFile)) {
                console.log(`Found output file, reading transcript from: ${expectedOutputFile}`);
                transcription = fs.readFileSync(expectedOutputFile, 'utf8').trim();
                console.log(`Read ${transcription.length} characters from transcript file.`);
            } else {
                console.warn(`Output file not found: ${expectedOutputFile}. Checking stdout as fallback.`);
                transcription = stdout.trim();
                try {
                    const files = fs.readdirSync(outputDirectory);
                    console.log(`Files currently in output directory (${outputDirectory}): ${files.join(', ')}`);
                } catch (readDirError) {
                    console.error(`Could not read output directory ${outputDirectory}:`, readDirError);
                }
                 if (!transcription) {
                     // If file doesn't exist AND stdout is empty, it likely failed.
                     throw new Error(`Whisper command completed but produced no output file (${expectedOutputFile}) and no stdout content.`);
                 }
            }

            if (!transcription) {
                console.warn(`Warning: Empty transcription result for ${audioPath}`);
            }

            return transcription;
        } catch (error) {
            console.error(`Error transcribing with local ${providerLabel}:`, error.message);
            if (error.stderr) console.error(`Whisper Stderr (${providerLabel}):\n${error.stderr}`);
            if (error.stdout) console.error(`Whisper Stdout (${providerLabel}):\n${error.stdout}`);
            // Include command in error for easier debugging
            throw new Error(`Local transcription (${providerLabel}) failed for command [${cmd}]: ${error.message}`);
        }
    }

    private async transcribeWithAssemblyAI(
        audioPath: string,
        options: TranscriptionOptions = {}
    ): Promise<string> {
        // (Keep existing AssemblyAI implementation - unchanged from previous version)
        try {
            const apiKey = options.apiKey || this.apiKeys['assemblyai'];
            if (!apiKey) throw new Error('AssemblyAI API key not provided');
            const audioBuffer = fs.readFileSync(audioPath);
            const uploadResponse = await axios.post('https://api.assemblyai.com/v2/upload', audioBuffer, {
                headers: { 'Content-Type': 'application/octet-stream', 'Authorization': apiKey }
            });
            const audioUrl = uploadResponse.data.upload_url;
            console.log(`Uploaded audio to AssemblyAI: ${audioUrl}`);
            const transcriptionResponse = await axios.post('https://api.assemblyai.com/v2/transcript', {
                audio_url: audioUrl, language_code: options.language || 'en'
            }, { headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' } });
            const transcriptId = transcriptionResponse.data.id;
            console.log(`AssemblyAI transcription job submitted with ID: ${transcriptId}`);
            let result;
            const startTime = Date.now();
            const timeoutMillis = 30 * 60 * 1000;
            while (true) {
                 if (Date.now() - startTime > timeoutMillis) throw new Error(`AssemblyAI transcription timed out for ID: ${transcriptId}`);
                await new Promise(resolve => setTimeout(resolve, 5000));
                const checkResponse = await axios.get(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, { headers: { 'Authorization': apiKey } });
                const status = checkResponse.data.status;
                console.log(`AssemblyAI transcription status [${transcriptId}]: ${status}`);
                if (status === 'completed') { result = checkResponse.data.text; break; }
                if (status === 'error') throw new Error(`AssemblyAI transcription failed [${transcriptId}]: ${checkResponse.data.error}`);
            }
            return result || '';
        } catch (error) {
            console.error('Error transcribing with AssemblyAI:', error.response?.data || error.message || error);
            throw new Error(`AssemblyAI transcription failed: ${error.message}`);
        }
    }

    private async transcribeWithGoogle(
        audioPath: string,
        options: TranscriptionOptions = {}
    ): Promise<string> {
        // (Keep existing Google implementation - unchanged from previous version)
         try {
            const apiKey = options.apiKey || this.apiKeys['google'];
            if (!apiKey) throw new Error('Google API key not provided');
            console.log(`Transcribing with Google Speech-to-Text for: ${audioPath}`);
            const audioBuffer = fs.readFileSync(audioPath);
            const audioContent = audioBuffer.toString('base64');
            const response = await axios.post(
                `https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}`,
                {
                    config: { encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode: options.language || 'en-US', enableAutomaticPunctuation: true },
                    audio: { content: audioContent }
                },
                { headers: { 'Content-Type': 'application/json' } }
            );
            let transcript = '';
            if (response.data.results?.length > 0) {
                transcript = response.data.results.map((result: any) => result.alternatives[0].transcript).join(' ').trim();
                console.log(`Google transcription successful. Length: ${transcript.length}`);
            } else {
                console.warn('Google transcription returned no results.');
                 if (response.data.error) {
                    console.error('Google API Error:', response.data.error);
                    throw new Error(`Google API Error: ${response.data.error.message}`);
                }
            }
            return transcript;
        } catch (error) {
            console.error('Error transcribing with Google:', error.response?.data || error.message || error);
             const errorMessage = error.response?.data?.error?.message || error.message;
            throw new Error(`Google transcription failed: ${errorMessage}`);
        }
    }

    private async downloadModel(modelSize: string): Promise<void> {
        // (Keep existing downloadModel implementation - unchanged from previous version)
        try {
            const modelFileName = `ggml-${modelSize}.bin`;
            const modelUrl = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${modelFileName}`;
            const modelFilePath = path.join(this.modelPath, modelFileName);
            if (fs.existsSync(modelFilePath)) {
                console.log(`Model ${modelSize} already exists at ${modelFilePath}. Skipping download.`);
                return;
            }
            console.log(`Downloading model ${modelSize} from ${modelUrl} to ${modelFilePath}...`);
            try {
                await execAsync(`wget -q --show-progress -O "${modelFilePath}" "${modelUrl}"`);
            } catch (wgetError) {
                console.warn(`wget failed, trying curl: ${wgetError.message}`);
                try { await execAsync(`curl -L "${modelUrl}" -o "${modelFilePath}"`); }
                catch (curlError) {
                    console.error(`Both wget and curl failed: ${curlError.message}`);
                    if (fs.existsSync(modelFilePath)) fs.unlinkSync(modelFilePath);
                    throw new Error(`Failed to download model ${modelSize}`);
                }
            }
            console.log(`Model ${modelSize} downloaded successfully to ${modelFilePath}`);
        } catch (error) {
            console.error('Error in downloadModel:', error);
        }
    }

    public async transcribeMediaFile(
        filePath: string,
        options: TranscriptionOptions = {},
        statusCallback?: (status: string) => Promise<void>,
        outputDirectory?: string // Allow specifying output dir, defaults to temp
    ): Promise<string> {
        console.log(`Starting media transcription for: ${filePath}`);
        if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

        const finalOutputDirectory = outputDirectory || os.tmpdir(); // Use provided or temp
        const tempAudioDir = path.join(os.tmpdir(), `flowise-temp-audio-${Date.now()}`); // Unique temp dir
        fs.mkdirSync(tempAudioDir, { recursive: true });

        let audioPath = filePath;
        let extractedAudio = false;
        const fileExt = path.extname(filePath).toLowerCase();
        const isVideo = SUPPORTED_VIDEO_EXTENSIONS.includes(fileExt);
        const isAudio = SUPPORTED_AUDIO_EXTENSIONS.includes(fileExt);

        if (!isAudio && !isVideo) throw new Error(`Unsupported file type: ${fileExt}`);

        // --- Improved Audio Extraction ---
        if (isVideo) {
            if (statusCallback) await statusCallback("Extracting audio from video...");
            const fileId = path.basename(filePath, fileExt);
            audioPath = path.join(tempAudioDir, `${fileId}.wav`); // Use predictable name in temp dir
            extractedAudio = true;

            // REMOVED: -t 600 limit
            const ffmpegCmd = `ffmpeg -y -i "${filePath}" -vn -ar 16000 -ac 1 -c:a pcm_s16le "${audioPath}"`;
            console.log(`Executing FFmpeg: ${ffmpegCmd}`);

            let timeoutReached = false;
            const timeoutMs = 15 * 60 * 1000; // 15 minutes timeout for ffmpeg

            try {
                const timeoutPromise = new Promise<never>((_, reject) => {
                    setTimeout(() => {
                        timeoutReached = true;
                        reject(new Error(`FFmpeg process timed out after ${timeoutMs / 1000 / 60} minutes`));
                    }, timeoutMs);
                });

                const execPromise = execAsync(ffmpegCmd, { maxBuffer: 20 * 1024 * 1024 }); // Increased buffer
                await Promise.race([execPromise, timeoutPromise]);
                console.log(`Successfully extracted audio to ${audioPath}`);

                // Check WAV file validity
                if (!fs.existsSync(audioPath) || fs.statSync(audioPath).size < 1000) {
                    console.error(`Error: FFmpeg finished but WAV file is missing or too small at ${audioPath}`);
                    throw new Error(`FFmpeg created an unusable WAV file.`);
                }

            } catch (ffmpegError) {
                console.error('FFmpeg error during audio extraction:', ffmpegError);
                if (timeoutReached) {
                    // Attempt to kill ffmpeg process if timed out
                    try {
                        await execAsync(`pkill -f "ffmpeg.*${path.basename(filePath)}"`);
                        console.log(`Killed FFmpeg process after timeout`);
                    } catch (killError) {
                        console.warn(`Error killing FFmpeg process: ${killError.message}`);
                    }
                }
                // Check if partial WAV exists and is usable
                if (fs.existsSync(audioPath) && fs.statSync(audioPath).size >= 1000) {
                    console.warn(`FFmpeg failed, but a partial WAV file exists (${audioPath}). Attempting to transcribe it.`);
                    // Continue to transcription block
                } else {
                    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath); // Cleanup failed extraction
                    // Don't remove tempAudioDir yet, might be needed for fallback
                    throw new Error(`Audio extraction failed: ${ffmpegError.message}`); // Re-throw original error
                }
            }
        }
        // --- End Improved Audio Extraction ---

        let transcriptionResult = '';
        let primaryProviderError: Error | null = null;
        const provider = options.provider || this.defaultProvider;

        try {
            const fileStats = fs.statSync(audioPath); // Use audioPath (might be original or extracted WAV)
            const fileSizeBytes = fileStats.size;
            const estimatedMinutes = this.estimateTranscriptionTime(fileSizeBytes, provider);

            if (statusCallback) {
                await statusCallback(
                    `Transcribing audio (${(fileSizeBytes / (1024 * 1024)).toFixed(1)} MB)...\n` +
                    `Provider: ${provider}, Model: ${options.modelSize || 'medium'}\n` +
                    `Est. time: ~${estimatedMinutes} mins`
                );
            }

            const audioBaseName = path.basename(audioPath, path.extname(audioPath));
            this.publishTranscriptionEstimate(audioBaseName, fileSizeBytes, provider);

            const transcriptionOptions: TranscriptionOptions = {
                ...options,
                provider: provider, // Ensure the primary provider is passed
                outputDirectory: finalOutputDirectory
            };

            transcriptionResult = await this.transcribe(audioPath, transcriptionOptions);

            if (statusCallback) await statusCallback("Transcription complete.");

        } catch (error) {
             console.error(`Primary transcription provider (${provider}) failed:`, error);
             primaryProviderError = error; // Store error for potential fallback
             if (statusCallback) await statusCallback(`Transcription failed with ${provider}: ${error.message}`);
             // Don't re-throw yet, attempt fallback
        }

        // --- Fallback Logic ---
        if (primaryProviderError && provider !== 'assemblyai' && this.apiKeys['assemblyai']) {
            console.log(`Attempting fallback transcription with AssemblyAI for ${audioPath}`);
            if (statusCallback) await statusCallback("Primary provider failed. Attempting fallback with AssemblyAI...");
            try {
                // Ensure a specific language code is passed to AssemblyAI, default to 'en' if original was 'auto'
                const fallbackLanguage = (options.language && options.language !== 'auto') ? options.language : 'en';
                console.log(`[Fallback] Using language code for AssemblyAI: ${fallbackLanguage}`);
                const fallbackOptions: TranscriptionOptions = {
                    ...options,
                    provider: 'assemblyai', // Force AssemblyAI
                    language: fallbackLanguage, // Use specific language
                    outputDirectory: finalOutputDirectory
                };
                transcriptionResult = await this.transcribe(audioPath, fallbackOptions); // Use audioPath (WAV if extracted, original otherwise)
                primaryProviderError = null; // Fallback succeeded
                if (statusCallback) await statusCallback("Fallback transcription with AssemblyAI successful.");
            } catch (fallbackError) {
                console.error('AssemblyAI fallback transcription also failed:', fallbackError);
                if (statusCallback) await statusCallback(`Fallback transcription failed: ${fallbackError.message}`);
                // If fallback fails, throw the *original* error
                throw primaryProviderError;
            }
        } else if (primaryProviderError) {
            // If no fallback possible or fallback failed, throw the original error
            throw primaryProviderError;
        }
        // --- End Fallback Logic ---

        // Cleanup extracted audio file and its directory (moved here to ensure it runs after potential fallback)
        if (extractedAudio && fs.existsSync(tempAudioDir)) {
            try {
                fs.rmSync(tempAudioDir, { recursive: true, force: true });
                console.log(`Cleaned up temporary audio directory: ${tempAudioDir}`);
            } catch (cleanupError) {
                console.warn(`Error cleaning up temp audio directory ${tempAudioDir}: ${cleanupError}`);
            }
        }

        return transcriptionResult;
    }

    // Keep estimateTranscriptionTime as is
    private estimateTranscriptionTime(fileSizeBytes: number, provider: TranscriptionProvider): number {
        const fileSizeMB = fileSizeBytes / (1024 * 1024);
        const processingSpeed: Record<string, number> = { 'local-cuda': 20, 'local-cpu': 5, 'assemblyai': 10, 'google': 12 };
        const speed = processingSpeed[provider] || processingSpeed['local-cpu'];
        let estimatedMinutes = Math.max(0.5, fileSizeMB / speed);
        estimatedMinutes += 0.5; // Add buffer time
        return Math.ceil(estimatedMinutes * 2) / 2; // Round up to nearest 0.5 min
    }

    private publishTranscriptionEstimate(videoId: string, fileSizeBytes: number, provider: TranscriptionProvider): void {
        // (Keep existing publishing logic - unchanged)
         try {
            const estimatedMinutes = this.estimateTranscriptionTime(fileSizeBytes, provider);
            const estimate: TranscriptionEstimate = { videoId, estimatedMinutes, timestamp: Date.now() };
            if (!(global as any).transcriptionEstimates) (global as any).transcriptionEstimates = new Map<string, TranscriptionEstimate>();
            (global as any).transcriptionEstimates.set(videoId, estimate);
            console.log(`[TranscriptionService] Published estimate: ~${estimatedMinutes} mins for ${videoId} (${provider})`);
        } catch (error) { console.warn(`[TranscriptionService] Error publishing estimate:`, error); }
    }

    // --- New Method for Processing Folder ---
    /**
     * Processes all supported media files found in the designated input folder.
     * Transcribes them and moves the original file and the transcript to the processed folder.
     * @param options Transcription options to apply to all files in the folder.
     * @param statusCallback Optional callback for progress updates.
     * @returns Promise resolving to a summary of processed files and errors.
     */
    public async processTranscriptionFolder(
        options: TranscriptionOptions = {},
        statusCallback?: (status: string) => Promise<void>
    ): Promise<{ processed: string[], errors: { file: string, error: string }[] }> {
        console.log(`Starting processing of transcription folder: ${this.inputFolderPath}`);
        if (statusCallback) await statusCallback(`Scanning folder: ${this.inputFolderPath}...`);

        let filesToProcess: string[] = [];
        try {
            filesToProcess = fs.readdirSync(this.inputFolderPath)
                .map(fileName => path.join(this.inputFolderPath, fileName))
                .filter(filePath => {
                    try {
                        const stats = fs.statSync(filePath);
                        const ext = path.extname(filePath).toLowerCase();
                        // Ensure it's a file and not in the 'processed' subdirectory
                        return stats.isFile() && SUPPORTED_MEDIA_EXTENSIONS.includes(ext);
                    } catch { return false; }
                });
        } catch (readDirError) {
            console.error(`Error reading input directory ${this.inputFolderPath}:`, readDirError);
            if (statusCallback) await statusCallback(`Error reading input folder: ${readDirError.message}`);
            return { processed: [], errors: [{ file: this.inputFolderPath, error: `Failed to read directory: ${readDirError.message}` }] };
        }

        if (filesToProcess.length === 0) {
            console.log("No supported media files found in the input folder.");
            if (statusCallback) await statusCallback("No new files to process.");
            return { processed: [], errors: [] };
        }

        const totalFiles = filesToProcess.length;
        console.log(`Found ${totalFiles} media files to process.`);
        if (statusCallback) await statusCallback(`Found ${totalFiles} files. Starting transcription...`);

        const results = { processed: [] as string[], errors: [] as { file: string, error: string }[] };

        for (let i = 0; i < totalFiles; i++) {
            const filePath = filesToProcess[i];
            const fileName = path.basename(filePath);
            const fileNumber = i + 1;

            console.log(`\nProcessing file ${fileNumber}/${totalFiles}: ${fileName}`);
            if (statusCallback) await statusCallback(`Processing file ${fileNumber}/${totalFiles}: ${fileName}...`);

            try {
                // Transcribe the file, outputting the .txt to the dedicated transcript folder
                const transcription = await this.transcribeMediaFile(
                    filePath,
                    options, // Pass user-defined options (provider, model, lang)
                    async (status) => { // Nested status callback for this specific file
                        if (statusCallback) await statusCallback(`[${fileName}] ${status}`);
                    },
                    this.transcriptOutputFolderPath // Specify the output dir for the .txt file
                );

                console.log(`Successfully transcribed ${fileName}. Length: ${transcription.length}`);

                // --- Move Files After Successful Transcription ---
                const baseName = path.basename(filePath, path.extname(filePath));
                // Construct transcript file name based on the original file's base name
                const transcriptFileName = `${baseName}.txt`; // Use baseName declared above (line 568)
                const expectedTranscriptPath = path.join(this.transcriptOutputFolderPath, transcriptFileName); // Use transcriptFileName declared above

                // 1. Verify transcript exists
                if (!fs.existsSync(expectedTranscriptPath)) {
                     console.warn(`Transcript file ${expectedTranscriptPath} not found after successful transcription of ${fileName}. Writing manually.`);
                     // Ensure the transcript folder exists before writing
                     if (!fs.existsSync(this.transcriptOutputFolderPath)) {
                         fs.mkdirSync(this.transcriptOutputFolderPath, { recursive: true });
                     }
                     fs.writeFileSync(expectedTranscriptPath, transcription, 'utf8');
                }

                // 2. Move the original media file to the 'processed' folder (main level)
                const processedFilePath = path.join(this.processedFolderPath, fileName);
                try {
                    // Ensure the processed folder exists before moving
                    if (!fs.existsSync(this.processedFolderPath)) {
                        fs.mkdirSync(this.processedFolderPath, { recursive: true });
                    }
                    fs.renameSync(filePath, processedFilePath);
                    console.log(`Moved original file to: ${processedFilePath}`);
                    results.processed.push(fileName);
                } catch (moveError) {
                     console.error(`Failed to move original file ${fileName} to processed folder:`, moveError);
                     results.errors.push({ file: fileName, error: `Transcription successful, but failed to move original file: ${moveError.message}` });
                }

            } catch (error) {
                const errorMessage = error.message || 'Unknown error during transcription';
                console.error(`Error processing file ${fileName}:`, errorMessage);
                 if (error.stack) console.error(error.stack); // Log stack trace for more details
                if (statusCallback) await statusCallback(`Error processing ${fileName}: ${errorMessage}`);
                results.errors.push({ file: fileName, error: errorMessage });

                 // Attempt to move the failed file to processed folder (main level) to avoid reprocessing
                 const failedFilePath = path.join(this.processedFolderPath, `FAILED_${fileName}`);
                 try {
                     if (fs.existsSync(filePath)) {
                         // Ensure the processed folder exists before moving
                         if (!fs.existsSync(this.processedFolderPath)) {
                             fs.mkdirSync(this.processedFolderPath, { recursive: true });
                         }
                         fs.renameSync(filePath, failedFilePath);
                         console.log(`Moved failed file to: ${failedFilePath}`);
                     }
                 } catch (moveError) {
                     console.error(`Failed to move problematic file ${fileName} after error:`, moveError);
                 }
            }
        }

        console.log(`\nFolder processing complete. Processed: ${results.processed.length}, Errors: ${results.errors.length}`);
        if (statusCallback) {
            let summary = `Folder processing complete.\nSuccessfully processed: ${results.processed.length} files.`;
            if (results.errors.length > 0) {
                summary += `\nEncountered errors with ${results.errors.length} files:\n`;
                summary += results.errors.map(e => `- ${e.file}: ${e.error}`).join('\n');
            }
            await statusCallback(summary);
        }

        return results;
    }

    /**
     * Transcribes a single media file and moves the original and transcript
     * to appropriate processed folders.
     * @param filePath Absolute path to the media file in the input folder.
     * @param options Transcription options.
     * @param statusCallback Optional callback for progress updates.
     * @returns Promise resolving to the transcription text or throwing an error.
     */
    public async processSingleFileAndMove(
        filePath: string,
        options: TranscriptionOptions = {},
        statusCallback?: (status: string) => Promise<void>
    ): Promise<string> {
        const methodName = 'processSingleFileAndMove';
        const fileName = path.basename(filePath);
        console.log(`[${methodName}] Starting processing for: ${fileName}`);

        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        let transcriptionResult: string;
        try {
            // Transcribe the file, outputting the .txt to the dedicated transcript folder
            transcriptionResult = await this.transcribeMediaFile(
                filePath,
                options, // Pass merged options
                async (status) => { // Nested status callback
                    if (statusCallback) await statusCallback(`[${fileName}] ${status}`);
                },
                this.transcriptOutputFolderPath // Specify the output dir for the .txt file
            );

            console.log(`[${methodName}] Successfully transcribed ${fileName}. Length: ${transcriptionResult.length}`);

            // --- Move Files After Successful Transcription ---
            const baseName = path.basename(filePath, path.extname(filePath));
            const transcriptFileName = `${baseName}.txt`;
            const expectedTranscriptPath = path.join(this.transcriptOutputFolderPath, transcriptFileName);

            // 1. Verify transcript exists (it should, as transcribeMediaFile uses it)
            if (!fs.existsSync(expectedTranscriptPath)) {
                 console.warn(`[${methodName}] Transcript file ${expectedTranscriptPath} not found after successful transcription of ${fileName}. Writing manually.`);
                 // Ensure the transcript folder exists before writing
                 if (!fs.existsSync(this.transcriptOutputFolderPath)) {
                     fs.mkdirSync(this.transcriptOutputFolderPath, { recursive: true });
                 }
                 fs.writeFileSync(expectedTranscriptPath, transcriptionResult, 'utf8');
            }

            // 2. Move the original media file to the 'processed' folder (main level)
            const processedFilePath = path.join(this.processedFolderPath, fileName);
            try {
                // Ensure the processed folder exists before moving
                if (!fs.existsSync(this.processedFolderPath)) {
                    fs.mkdirSync(this.processedFolderPath, { recursive: true });
                }
                fs.renameSync(filePath, processedFilePath);
                console.log(`[${methodName}] Moved original file to: ${processedFilePath}`);
            } catch (moveError) {
                 console.error(`[${methodName}] Failed to move original file ${fileName} to processed folder:`, moveError);
                 // Log error but don't throw, transcription was successful
                 if (statusCallback) await statusCallback(`⚠️ Transcription successful, but failed to move original file.`);
            }

            return transcriptionResult;

        } catch (error) {
            const errorMessage = error.message || 'Unknown error during transcription';
            console.error(`[${methodName}] Error processing file ${fileName}:`, errorMessage);
             if (error.stack) console.error(error.stack);
            if (statusCallback) await statusCallback(`❌ Error processing ${fileName}: ${errorMessage}`);

             // Attempt to move the failed file to processed folder (main level) to avoid reprocessing
             const failedFilePath = path.join(this.processedFolderPath, `FAILED_${fileName}`);
             try {
                 if (fs.existsSync(filePath)) {
                     // Ensure the processed folder exists before moving
                     if (!fs.existsSync(this.processedFolderPath)) {
                         fs.mkdirSync(this.processedFolderPath, { recursive: true });
                     }
                     fs.renameSync(filePath, failedFilePath);
                     console.log(`[${methodName}] Moved failed file to: ${failedFilePath}`);
                 }
             } catch (moveError) {
                 console.error(`[${methodName}] Failed to move problematic file ${fileName} after error:`, moveError);
             }
             // Re-throw the original error
             throw error;
        }
    }
}

// Optional: Add a cleanup routine for old estimates if the map grows too large
setInterval(() => {
    if ((global as any).transcriptionEstimates instanceof Map) {
        const now = Date.now();
        const expirationTime = 60 * 60 * 1000; // 1 hour expiration
        for (const [key, estimate] of (global as any).transcriptionEstimates.entries()) {
            if (now - estimate.timestamp > expirationTime) {
                (global as any).transcriptionEstimates.delete(key);
                console.log(`[TranscriptionService] Cleaned up expired estimate for ${key}`);
            }
        }
    }
}, 5 * 60 * 1000); // Run cleanup every 5 minutes