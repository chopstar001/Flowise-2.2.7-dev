// services/TranscriptionService.ts
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
} from '../commands/types';
const execAsync = promisify(exec);


export class TranscriptionService {
    private defaultProvider: TranscriptionProvider = 'local-cuda';
    private modelPath: string;
    private whisperPath: string;
    private apiKeys: Record<string, string> = {};

    // In TranscriptionService.ts
    // Update the constructor to use the correct path

    constructor(config: {
        defaultProvider?: TranscriptionProvider;
        modelPath?: string;
        whisperPath?: string;
        apiKeys?: Record<string, string>;
    } = {}) {
        this.defaultProvider = config.defaultProvider || 'local-cuda';
        this.modelPath = config.modelPath || path.join(process.cwd(), 'models');

        // Update to use the correct path where Whisper is actually installed
        this.whisperPath = config.whisperPath || '/usr/bin/whisper'; // Changed from /usr/local/bin/whisper

        this.apiKeys = config.apiKeys || {};

        // Create model directory if it doesn't exist
        if (!fs.existsSync(this.modelPath)) {
            fs.mkdirSync(this.modelPath, { recursive: true });
        }

        // Check if CUDA is actually available for PyTorch
        this.checkCudaAvailability().then(cudaAvailable => {
            if (cudaAvailable) {
                console.log('CUDA is available for PyTorch - using GPU acceleration');
                this.defaultProvider = config.defaultProvider || 'local-cuda';
            } else {
                console.log('CUDA is not available for PyTorch - using CPU only');
                this.defaultProvider = 'local-cpu';
            }

            // Log available providers
            const availableProviders = [this.defaultProvider];

            if (this.defaultProvider === 'local-cuda') {
                availableProviders.push('local-cpu'); // CPU always available as fallback
            }

            if (this.apiKeys['assemblyai'] && this.apiKeys['assemblyai'].length > 0) {
                availableProviders.push('assemblyai');
            }
            if (this.apiKeys['google'] && this.apiKeys['google'].length > 0) {
                availableProviders.push('google');
            }

            console.log(`TranscriptionService initialized with available providers: ${availableProviders.join(', ')}`);
        }).catch(error => {
            console.warn('Error checking CUDA availability:', error);
            this.defaultProvider = 'local-cpu'; // Fallback to CPU
            console.log('TranscriptionService initialized with CPU provider due to CUDA check error');
        });
    }

    // Add this method to check CUDA availability
    private async checkCudaAvailability(): Promise<boolean> {
        try {
            // Create a temporary script to check CUDA
            const tempDir = path.join(os.tmpdir(), 'whisper-cuda-check');
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }

            const scriptPath = path.join(tempDir, 'cuda_check.py');
            const script = `
import torch
import sys
cuda_available = torch.cuda.is_available()
print(f"CUDA available: {cuda_available}")
if cuda_available:
    print(f"CUDA device: {torch.cuda.get_device_name(0)}")
    print(f"CUDA version: {torch.version.cuda}")
else:
    print("CUDA not available for PyTorch")
sys.exit(0 if cuda_available else 1)
`;
            fs.writeFileSync(scriptPath, script);

            // Run the script
            const { stdout } = await execAsync(`python3 ${scriptPath}`);
            console.log(`CUDA check result: ${stdout.trim()}`);

            // Clean up
            fs.unlinkSync(scriptPath);

            // If we got here without an error, CUDA is available
            return true;
        } catch (error) {
            // If the script exited with non-zero, CUDA is not available
            console.warn('CUDA availability check failed:', error);
            return false;
        }
    }

    public async transcribe(
        audioPath: string,
        options: TranscriptionOptions = {}
    ): Promise<string> {
        const provider = options.provider || this.defaultProvider;
        const modelSize = options.modelSize || 'medium';

        console.log(`Transcribing audio using ${provider} provider with ${modelSize} model`);

        switch (provider) {
            case 'local-cuda':
                return this.transcribeWithLocalCuda(audioPath, modelSize, options);
            case 'local-cpu':
                return this.transcribeWithLocalCpu(audioPath, modelSize, options);
            case 'assemblyai':
                return this.transcribeWithAssemblyAI(audioPath, options);
            case 'google':
                return this.transcribeWithGoogle(audioPath, options);
            default:
                throw new Error(`Unsupported transcription provider: ${provider}`);
        }
    }

    private async transcribeWithLocalCuda(
        audioPath: string,
        modelSize: string = 'medium',
        options: TranscriptionOptions = {}
    ): Promise<string> {
        try {
            console.log(`Starting transcription with CUDA for file: ${audioPath}`);

            // First verify that the audio file exists
            if (!fs.existsSync(audioPath)) {
                console.error(`Audio file not found at path: ${audioPath}`);
                throw new Error(`Audio file not found: ${audioPath}`);
            }
            console.log(`Verified audio file exists: ${audioPath}`);

            // Check if CUDA is available using a simple PyTorch script
            try {
                // Create a temporary script to check CUDA availability
                const cudaCheckScript = `
import torch
print(f"CUDA available: {torch.cuda.is_available()}")
if torch.cuda.is_available():
    print(f"CUDA device: {torch.cuda.get_device_name(0)}")
    print(f"CUDA version: {torch.version.cuda}")
else:
    print("CUDA devices not found or not properly configured")
    print(f"PyTorch version: {torch.__version__}")
`;
                const tempScriptPath = path.join(path.dirname(audioPath), 'cuda_check.py');
                fs.writeFileSync(tempScriptPath, cudaCheckScript);

                const { stdout: cudaCheck } = await execAsync(`python3 ${tempScriptPath}`);
                console.log(`CUDA availability check: ${cudaCheck.trim()}`);

                // Determine if CUDA is actually available
                const cudaAvailable = cudaCheck.includes('CUDA available: True');

                // Set device flag based on availability
                const deviceFlag = cudaAvailable ? '--device cuda' : '';

                // Clean up temp script
                fs.unlinkSync(tempScriptPath);

                if (!cudaAvailable) {
                    console.warn('CUDA is not available for PyTorch, falling back to CPU');
                }

                // For OpenAI Whisper, we don't need to specify a model file path
                // It will download the model automatically if needed
                // Set language parameter if specified
                const langParam = options.language && options.language !== 'auto' ?
                    `--language ${options.language}` : '';

                // Create output directory in same location as audio file
                const outputDir = path.dirname(audioPath);
                console.log(`Using output directory: ${outputDir}`);

                // Ensure temporary directory exists
                if (!fs.existsSync(outputDir)) {
                    fs.mkdirSync(outputDir, { recursive: true });
                    console.log(`Created output directory: ${outputDir}`);
                }

                // Construct command for OpenAI Whisper
                // Note: We're using the standard model name directly without a file path
                // OpenAI Whisper will handle model downloading itself
                const cmd = `${this.whisperPath} "${audioPath}" --model ${modelSize} --device cuda ${langParam} --output_dir "${outputDir}" --output_format txt`;
                console.log(`Executing Whisper command: ${cmd}`);

                // Execute Whisper command
                const { stdout, stderr } = await execAsync(cmd, { maxBuffer: 1024 * 1024 * 10 }); // Increase buffer size for large outputs

                if (stderr && stderr.trim()) {
                    console.warn('Warnings/messages from Whisper:', stderr);
                }

                // OpenAI Whisper typically saves the transcript to a .txt file with the same base name
                const expectedOutputFile = path.join(outputDir, `${path.basename(audioPath, path.extname(audioPath))}.txt`);
                console.log(`Checking for output file: ${expectedOutputFile}`);

                // Check if the output file exists
                let transcription = '';
                if (fs.existsSync(expectedOutputFile)) {
                    console.log(`Found output file, reading transcript from: ${expectedOutputFile}`);
                    transcription = fs.readFileSync(expectedOutputFile, 'utf8').trim();
                    console.log(`Read ${transcription.length} characters from transcript file`);
                } else {
                    // If no output file, check if there's output in stdout
                    console.log(`No output file found, using stdout. Stdout length: ${stdout.length}`);
                    transcription = stdout.trim();

                    // List files in output directory to debug
                    const files = fs.readdirSync(outputDir);
                    console.log(`Files in output directory: ${files.join(', ')}`);
                }

                if (!transcription) {
                    console.warn('Warning: Empty transcription result');
                }

                return transcription;
            } catch (cudaError) {
                console.error('Error checking CUDA availability or running with CUDA:', cudaError);
                throw cudaError;
            }
        } catch (error) {
            console.error('Error transcribing with local CUDA:', error);
            throw error;
        }
    }

    private async transcribeWithLocalCpu(
        audioPath: string,
        modelSize: string = 'base',
        options: TranscriptionOptions = {}
    ): Promise<string> {
        try {
            console.log(`Starting transcription with CPU for file: ${audioPath}`);

            // First verify that the audio file exists
            if (!fs.existsSync(audioPath)) {
                console.error(`Audio file not found at path: ${audioPath}`);
                throw new Error(`Audio file not found: ${audioPath}`);
            }
            console.log(`Verified audio file exists: ${audioPath}`);

            // Set language parameter if specified
            const langParam = options.language && options.language !== 'auto' ?
                `--language ${options.language}` : '';

            // Create output directory in same location as audio file
            const outputDir = path.dirname(audioPath);
            console.log(`Using output directory: ${outputDir}`);

            // Construct command for OpenAI Whisper (CPU version - no device flag)
            const cmd = `${this.whisperPath} "${audioPath}" --model ${modelSize} ${langParam} --output_dir "${outputDir}" --output_format txt`;
            console.log(`Executing Whisper command: ${cmd}`);

            // Execute Whisper command
            const { stdout, stderr } = await execAsync(cmd, { maxBuffer: 1024 * 1024 * 10 });

            if (stderr && stderr.trim()) {
                console.warn('Warnings/messages from Whisper:', stderr);
            }

            // OpenAI Whisper typically saves the transcript to a .txt file with the same base name
            const expectedOutputFile = path.join(outputDir, `${path.basename(audioPath, path.extname(audioPath))}.txt`);
            console.log(`Checking for output file: ${expectedOutputFile}`);

            // Check if the output file exists
            let transcription = '';
            if (fs.existsSync(expectedOutputFile)) {
                console.log(`Found output file, reading transcript from: ${expectedOutputFile}`);
                transcription = fs.readFileSync(expectedOutputFile, 'utf8').trim();
            } else {
                // If no output file, check if there's output in stdout
                console.log(`No output file found, using stdout. Stdout length: ${stdout.length}`);
                transcription = stdout.trim();

                // List files in output directory to debug
                const files = fs.readdirSync(outputDir);
                console.log(`Files in output directory: ${files.join(', ')}`);
            }

            if (!transcription) {
                console.warn('Warning: Empty transcription result');
            }

            return transcription;
        } catch (error) {
            console.error('Error transcribing with local CPU:', error);
            throw error;
        }
    }

    private async transcribeWithAssemblyAI(
        audioPath: string,
        options: TranscriptionOptions = {}
    ): Promise<string> {
        try {
            const apiKey = options.apiKey || this.apiKeys['assemblyai'];

            if (!apiKey) {
                throw new Error('AssemblyAI API key not provided');
            }

            // Read the audio file as a buffer
            const audioBuffer = fs.readFileSync(audioPath);

            // Step 1: Upload the audio file
            const uploadResponse = await axios.post('https://api.assemblyai.com/v2/upload', audioBuffer, {
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'Authorization': apiKey
                }
            });

            const audioUrl = uploadResponse.data.upload_url;
            console.log(`Uploaded audio to AssemblyAI: ${audioUrl}`);

            // Step 2: Submit for transcription
            const transcriptionResponse = await axios.post('https://api.assemblyai.com/v2/transcript', {
                audio_url: audioUrl,
                language_code: options.language || 'en'
            }, {
                headers: {
                    'Authorization': apiKey,
                    'Content-Type': 'application/json'
                }
            });

            const transcriptId = transcriptionResponse.data.id;
            console.log(`Transcription job submitted with ID: ${transcriptId}`);

            // Step 3: Poll for completion
            let result;
            while (true) {
                await new Promise(resolve => setTimeout(resolve, 2000)); // Poll every 2 seconds

                const checkResponse = await axios.get(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
                    headers: {
                        'Authorization': apiKey
                    }
                });

                if (checkResponse.data.status === 'completed') {
                    result = checkResponse.data.text;
                    break;
                } else if (checkResponse.data.status === 'error') {
                    throw new Error(`AssemblyAI transcription failed: ${checkResponse.data.error}`);
                }

                console.log(`Transcription status: ${checkResponse.data.status}`);
            }

            return result;
        } catch (error) {
            console.error('Error transcribing with AssemblyAI:', error);
            throw error;
        }
    }

    private async transcribeWithGoogle(
        audioPath: string,
        options: TranscriptionOptions = {}
    ): Promise<string> {
        try {
            const apiKey = options.apiKey || this.apiKeys['google'];

            if (!apiKey) {
                throw new Error('Google API key not provided');
            }

            // This is a simplified example - in practice you'd need to use the Google Cloud client library
            // Here we're just showing the general approach

            // Read the audio file and convert to base64
            const audioContent = fs.readFileSync(audioPath).toString('base64');

            // Call the Speech-to-Text API
            const response = await axios.post(
                `https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}`,
                {
                    config: {
                        encoding: 'LINEAR16',
                        sampleRateHertz: 16000,
                        languageCode: options.language || 'en-US',
                    },
                    audio: {
                        content: audioContent
                    }
                }
            );

            // Extract and return the transcript
            let transcript = '';
            if (response.data.results) {
                transcript = response.data.results
                    .map((result: any) => result.alternatives[0].transcript)
                    .join(' ');
            }

            return transcript;
        } catch (error) {
            console.error('Error transcribing with Google:', error);
            throw error;
        }
    }

    private async downloadModel(modelSize: string): Promise<void> {
        try {
            const modelUrl = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${modelSize}.bin`;
            const modelPath = path.join(this.modelPath, `ggml-${modelSize}.bin`);

            console.log(`Downloading model from ${modelUrl}...`);

            // Use wget or curl to download the model
            await execAsync(`wget ${modelUrl} -O ${modelPath} || curl -L ${modelUrl} -o ${modelPath}`);

            console.log(`Model downloaded to ${modelPath}`);
        } catch (error) {
            console.error('Error downloading model:', error);
            throw error;
        }
    }

    // In TranscriptionService.ts

    /**
     * Transcribes media files (audio or video) with proper audio extraction if needed
     * @param filePath Path to the media file (audio or video)
     * @param options Transcription options including provider, model size, and language
     * @param statusCallback Optional callback function to report progress
     * @returns Promise with the transcription text
     */
    public async transcribeMediaFile(
        filePath: string,
        options: TranscriptionOptions = {},
        statusCallback?: (status: string) => Promise<void>
    ): Promise<string> {
        console.log(`Starting media transcription for: ${filePath}`);

        // Validate file exists
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        // Extract audio if it's a video file
        let audioPath = filePath;
        const isVideo = /\.(mp4|mov|avi|mkv|webm)$/i.test(filePath);

        if (isVideo) {
            if (statusCallback) {
                await statusCallback("Extracting audio from video...");
            }

            const fileId = path.basename(filePath, path.extname(filePath));
            const tempDir = path.dirname(filePath);
            audioPath = path.join(tempDir, `${fileId}.wav`);

            try {
                // Use FFmpeg with careful parameters
                await execAsync(
                    `ffmpeg -y -i "${filePath}" -t 600 -ar 16000 -ac 1 -c:a pcm_s16le "${audioPath}"`,
                    { timeout: 300000, maxBuffer: 10 * 1024 * 1024 }
                );
                console.log(`Successfully extracted audio to ${audioPath}`);
            } catch (ffmpegError) {
                console.error('FFmpeg error:', ffmpegError);
                throw new Error(`Audio extraction failed: ${ffmpegError.message}`);
            }
        }

        // Get file size and estimate transcription time using our existing method
        const fileStats = fs.statSync(audioPath);
        const fileSizeBytes = fileStats.size;

        // Use provider from options or default
        const provider = options.provider || this.defaultProvider;

        // Use our existing estimation method
        const estimatedMinutes = this.estimateTranscriptionTime(fileSizeBytes, provider as TranscriptionProvider);

        if (statusCallback) {
            await statusCallback(
                `Transcribing audio... (${(fileSizeBytes / (1024 * 1024)).toFixed(1)} MB)\n` +
                `Estimated time: ${estimatedMinutes} minutes`
            );
        }

        // Create a video ID for the global estimates map if needed
        const videoId = path.basename(audioPath, path.extname(audioPath));

        // Publish the estimate for other components to use
        this.publishTranscriptionEstimate(videoId, fileSizeBytes, provider as TranscriptionProvider);

        // Determine which transcription method to use based on options
        const modelSize = options.modelSize || 'medium';
        const language = options.language || 'auto';

        console.log(`Using provider: ${provider}, model: ${modelSize}, language: ${language}`);

        // Transcribe the audio using our existing transcribe method
        let transcriptionResult: string;
        try {
            transcriptionResult = await this.transcribe(audioPath, {
                provider: provider as TranscriptionProvider,
                modelSize,
                language
            });
        } catch (error) {
            console.error('Transcription error:', error);

            // If the primary method fails, try a fallback method
            if (provider !== 'assemblyai' && this.apiKeys['assemblyai']) {
                console.log('Primary transcription failed, trying AssemblyAI fallback');
                if (statusCallback) {
                    await statusCallback('Primary transcription failed, trying alternative service...');
                }

                try {
                    transcriptionResult = await this.transcribe(audioPath, {
                        provider: 'assemblyai',
                        language
                    });
                } catch (fallbackError) {
                    // If fallback also fails, throw the original error
                    console.error('Fallback transcription also failed:', fallbackError);
                    throw error;
                }
            } else {
                throw error;
            }
        }

        // If the audio was extracted from video, clean up the audio file unless it's the original
        if (isVideo && audioPath !== filePath) {
            try {
                fs.unlinkSync(audioPath);
                console.log(`Cleaned up temporary audio file: ${audioPath}`);
            } catch (cleanupError) {
                console.warn(`Error cleaning up audio file: ${cleanupError}`);
            }
        }

        return transcriptionResult;
    }
    private estimateTranscriptionTime(fileSizeBytes: number, provider: TranscriptionProvider): number {
        // Convert bytes to MB for easier calculation
        const fileSizeMB = fileSizeBytes / (1024 * 1024);

        // Base speeds (MB per minute) for different providers
        // These are rough estimates based on observation and can be adjusted
        const processingSpeed: Record<string, number> = {
            'local-cuda': 15,    // RTX 3090 is fast - around 15MB/min
            'local-cpu': 5,      // CPU is slower - around 5MB/min
            'assemblyai': 10,    // AssemblyAI - around 10MB/min based on logs
            'google': 12         // Google - estimate based on their API
        };

        // Get appropriate speed or use assemblyai as fallback
        const speed = processingSpeed[provider] || processingSpeed.assemblyai;

        // Calculate time in minutes - ensure we have a reasonable minimum
        let estimatedMinutes = Math.max(1, fileSizeMB / speed);

        // Add a buffer for API latency and processing overhead
        estimatedMinutes += 1;

        // Round up to nearest 0.5 minute
        return Math.ceil(estimatedMinutes * 2) / 2;
    }
    /**
     * Publishes transcription estimate for use by other components
     * @param videoId Unique identifier for the video/audio
     * @param fileSizeBytes Size of the file in bytes
     * @param provider Transcription provider being used
     */
    private publishTranscriptionEstimate(videoId: string, fileSizeBytes: number, provider: TranscriptionProvider): void {
        try {
            const estimatedMinutes = this.estimateTranscriptionTime(fileSizeBytes, provider);

            // Store in the global map with a timestamp
            const estimate: TranscriptionEstimate = {
                videoId,
                estimatedMinutes,
                timestamp: Date.now()
            };

            // Initialize the global map if needed
            if (!(global as any).transcriptionEstimates) {
                (global as any).transcriptionEstimates = new Map();
            }

            (global as any).transcriptionEstimates.set(videoId, estimate);

            console.log(`[TranscriptionService] Published transcription estimate: ${estimatedMinutes} minutes for ${videoId}`);
        } catch (error) {
            console.warn(`[TranscriptionService] Error publishing estimate:`, error);
        }
    }
}