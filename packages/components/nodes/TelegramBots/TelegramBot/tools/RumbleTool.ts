// tools/RumbleTool.ts with focus on download and transcribe approach
import axios from 'axios';
import { Tool } from '@langchain/core/tools';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { TranscriptionService } from '../services/TranscriptionService';
import {
    TranscriptionProvider,
    TranscriptionOptions,
    TranscriptionEstimate
} from '../commands/types';
import { AssemblyAI } from 'assemblyai'

type StatusCallback = (status: string) => Promise<void>;

const execAsync = promisify(exec);

export class RumbleTool extends Tool {
    name = "rumble_tool";
    description = "Retrieve content from Rumble videos by downloading and transcribing";
    tempDir: string;
    ytDlpAvailable: boolean = false;
    ffmpegAvailable: boolean = false;
    private transcriptionService: TranscriptionService;

    transcriptionPreferences: Record<string, any> = {};
    assemblyAIAvailable: boolean = false;

    private statusCallback: StatusCallback | null = null;


    constructor(tempDir = './temp', config: {
        transcriptionPreferences?: Record<string, any>
    } = {}) {
        super();
        this.tempDir = tempDir;
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }

        // Initialize transcription service with debug info
        console.log(`Initializing TranscriptionService`);
        try {
            this.transcriptionService = new TranscriptionService({
                defaultProvider: 'local-cuda', // Use your RTX 3090 by default
                whisperPath: '/usr/bin/whisper', // Use the correct path we found
                apiKeys: {
                    'assemblyai': process.env.ASSEMBLYAI_API_KEY || '',
                    'google': process.env.GOOGLE_API_KEY || ''
                }
            });
            console.log(`TranscriptionService initialized successfully`);
        } catch (error) {
            console.error(`Error initializing TranscriptionService:`, error);
            throw error; // Re-throw to prevent the tool from initializing with a broken transcription service
        }
        // Store transcription preferences from config
        this.transcriptionPreferences = config.transcriptionPreferences || {};

        // Check dependencies availability
        this.checkDependenciesAvailability();

        // Check if AssemblyAI is available
        this.assemblyAIAvailable = !!process.env.ASSEMBLYAI_API_KEY;
        if (this.assemblyAIAvailable) {
            console.log('AssemblyAI API key found, transcription service available');
        } else {
            console.log('AssemblyAI API key not found, some transcription features may be limited');
        }
    }

    private async checkDependenciesAvailability(): Promise<void> {
        try {
            const ytDlpResult = await execAsync('yt-dlp --version');
            this.ytDlpAvailable = true;
            console.log(`yt-dlp version: ${ytDlpResult.stdout.trim()} is available`);
        } catch (error) {
            this.ytDlpAvailable = false;
            console.warn(`yt-dlp not available: ${error.message}`);
        }

        try {
            const ffmpegResult = await execAsync('ffmpeg -version');
            this.ffmpegAvailable = true;
            console.log(`ffmpeg is available`);
        } catch (error) {
            this.ffmpegAvailable = false;
            console.warn(`ffmpeg not available: ${error.message}`);
        }
    }

    static lc_name() {
        return "RumbleTool";
    }

    schema = z.object({
        input: z.string().optional().describe("A JSON string containing the Rumble URL and action"),
    }).transform(data => data.input ?? undefined);

    async _call(args: z.infer<typeof this.schema>): Promise<string> {
        try {
            if (!args) {
                return "Error: Missing input";
            }

            let { url, action, transcriptionOptions = {} } = JSON.parse(args);

            console.log(`Raw URL from input: "${url}"`);

            // Extract and validate the video ID
            const videoId = this.extractVideoId(url);
            console.log(`Extracted video ID: "${videoId}" from URL: "${url}"`);

            if (!videoId) {
                return "Error: Invalid Rumble URL. Please provide a valid Rumble video URL.";
            }

            // Normalize the URL for consistency
            const fullUrl = `https://rumble.com/embed/${videoId}`;

            switch (action) {
                case 'transcript': {
                    // Check if required tools are available
                    if (!this.ytDlpAvailable) {
                        return "Error: yt-dlp is required for transcript extraction but is not available. Please install it to use this feature.";
                    }

                    // Focus on downloading and transcribing, now passing the transcription options
                    const transcript = await this.downloadAndTranscribe(videoId, fullUrl, transcriptionOptions);
                    return transcript;
                }
                case 'metadata': {
                    const metadata = await this.getMetadata(videoId, fullUrl);
                    return metadata;
                }
                case 'download': {
                    // Check if yt-dlp is available
                    if (!this.ytDlpAvailable) {
                        return "Error: yt-dlp is required for video download but is not available. Please install it to use this feature.";
                    }

                    const downloadResult = await this.downloadVideo(videoId, fullUrl);
                    return downloadResult;
                }
                default:
                    return "Error: Unknown action. Available actions are: transcript, metadata, download";
            }
        } catch (error) {
            console.error("Rumble tool error:", error);
            return `Error: ${error instanceof Error ? error.message : 'Unknown error occurred while processing the Rumble request'}`;
        }
    }

    private extractVideoId(url: string): string | null {
        if (!url) {
            console.log('URL is empty or undefined');
            return null;
        }

        console.log(`Extracting video ID from: "${url}"`);

        // Array of patterns to try in order
        const patterns = [
            // Standard URL format with v-prefix: rumble.com/v123abc-title.html
            /(?:https?:\/\/)?(?:www\.)?rumble\.com\/v([a-zA-Z0-9]{5,})-[\w\.-]+\.html/i,

            // Standard URL with full ID: rumble.com/v123abc-title.html (capturing the v-prefix too)
            /(?:https?:\/\/)?(?:www\.)?rumble\.com\/(v[a-zA-Z0-9]{5,})-[\w\.-]+\.html/i,

            // Embed format: rumble.com/embed/v123abc
            /(?:https?:\/\/)?(?:www\.)?rumble\.com\/embed\/([a-zA-Z0-9]{5,})/i,

            // Embed format with v-prefix: rumble.com/embed/v123abc
            /(?:https?:\/\/)?(?:www\.)?rumble\.com\/embed\/(v[a-zA-Z0-9]{5,})/i,

            // Short URL format (if any)
            /(?:https?:\/\/)?(?:www\.)?rumble\.com\/([a-zA-Z0-9]{6,})\/?$/i
        ];

        // Try each pattern
        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match && match[1]) {
                // Normalize ID format - ensure it has the 'v' prefix
                const extractedId = match[1];
                const normalizedId = extractedId.startsWith('v') ? extractedId : `v${extractedId}`;
                console.log(`Extracted ID: "${extractedId}", Normalized: "${normalizedId}"`);
                return normalizedId;
            }
        }

        // If we get here, no standard patterns matched. Try one more general approach
        // Look for any segment that starts with v followed by at least 5 alphanumeric chars
        const generalMatch = url.match(/v([a-zA-Z0-9]{5,})/i);
        if (generalMatch) {
            const extractedPart = generalMatch[0]; // This includes the v prefix
            console.log(`Extracted ID via general pattern: "${extractedPart}"`);
            return extractedPart;
        }

        // If it's already just an ID format, return it (with v prefix if needed)
        if (/^v?[a-zA-Z0-9]{5,}$/.test(url)) {
            const normalizedId = url.startsWith('v') ? url : `v${url}`;
            console.log(`URL is already a valid video ID: "${url}", Normalized: "${normalizedId}"`);
            return normalizedId;
        }

        console.log('Failed to extract video ID');
        return null;
    }

    private async downloadAndTranscribe(videoId: string, fullUrl: string, options: TranscriptionOptions = {}): Promise<string> {
        try {
            console.log(`Downloading and transcribing video: ${videoId}`);

            // Generate unique output path based on videoId
            const outputDir = path.join(this.tempDir, videoId);
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
            }

            // Create multiple URL variations to try
            const urlVariations = [
                `https://rumble.com/v${videoId}`,      // Direct URL with 'v' prefix (most likely to work)
                `https://rumble.com/${videoId}`,       // Direct URL without 'v' prefix
                fullUrl                               // Original URL (likely embed URL)
            ];

            let redirectedIds = new Set<string>();

            // First attempt to check available formats to guide our approach
            let availableFormats = '';
            let bestFormatId = '';
            let workingUrl = '';

            try {
                for (const url of urlVariations) {
                    try {
                        console.log(`Checking available formats for: ${url}`);
                        const { stdout, stderr } = await execAsync(`yt-dlp --list-formats ${url}`);
                        availableFormats = stdout;

                        // Check if we got redirected to a different video ID
                        const redirectMatch = stderr.match(/\[RumbleEmbed\] ([\w\d]+): Downloading/);
                        if (redirectMatch && redirectMatch[1] && redirectMatch[1] !== videoId) {
                            const redirectedId = redirectMatch[1];
                            console.log(`Detected redirect to video ID: ${redirectedId}`);
                            redirectedIds.add(redirectedId);

                            // Add the redirected URLs to our variations
                            urlVariations.push(`https://rumble.com/v${redirectedId}`);
                            urlVariations.push(`https://rumble.com/embed/${redirectedId}`);
                        }

                        console.log(`Successfully found formats for: ${url}`);
                        workingUrl = url; // Remember which URL worked
                        break; // Exit the loop if we successfully get formats
                    } catch (error) {
                        console.log(`Failed to get formats for ${url}: ${error.message}`);

                        // Check the error message for redirected video IDs
                        const redirectMatch = error.message.match(/\[RumbleEmbed\] ([\w\d]+):/);
                        if (redirectMatch && redirectMatch[1] && redirectMatch[1] !== videoId) {
                            const redirectedId = redirectMatch[1];
                            console.log(`Detected redirect to video ID: ${redirectedId} in error message`);
                            redirectedIds.add(redirectedId);

                            // Add the redirected URLs to our variations if not already present
                            const redirectUrl1 = `https://rumble.com/v${redirectedId}`;
                            const redirectUrl2 = `https://rumble.com/embed/${redirectedId}`;

                            if (!urlVariations.includes(redirectUrl1)) {
                                urlVariations.push(redirectUrl1);
                            }
                            if (!urlVariations.includes(redirectUrl2)) {
                                urlVariations.push(redirectUrl2);
                            }
                        }
                    }
                }
            } catch (error) {
                console.log(`Error checking formats: ${error.message}`);
            }

            // If we couldn't get format info from any URL, return early
            if (!availableFormats || !workingUrl) {
                return `Could not access this Rumble video. It may be private, removed, or region-restricted.`;
            }

            console.log('Available formats:');
            console.log(availableFormats);

            // Parse the available formats and find a suitable format ID
            const formatLines = availableFormats.split('\n');

            // First try to find an audio-only format
            const audioFormats = formatLines.filter(line => line.includes('audio only'));

            if (audioFormats.length > 0) {
                // Found audio-only format
                const formatMatch = audioFormats[0].match(/^(\S+)/);
                if (formatMatch && formatMatch[1]) {
                    bestFormatId = formatMatch[1];
                    console.log(`Found audio-only format ID: ${bestFormatId}`);
                }
            } else {
                // No audio-only format, look for a video format (smallest file size first)
                // Filter lines that look like actual formats (have mp4, have filesize)
                const videoFormats = formatLines.filter(line =>
                    line.includes('mp4') &&
                    !line.includes('video only') &&
                    line.match(/\d+\.\d+\w+/) // Has a file size
                );

                if (videoFormats.length > 0) {
                    // Find the format ID from the first video format
                    const formatMatch = videoFormats[0].match(/^(\S+)/);
                    if (formatMatch && formatMatch[1]) {
                        bestFormatId = formatMatch[1];
                        console.log(`Found video format ID: ${bestFormatId}`);
                    }
                }
            }

            // If we still don't have a format ID, try to extract it from raw format string
            if (!bestFormatId) {
                // Look for lines with "ID" and "EXT" to find the format ID column
                const headerLine = formatLines.find(line => line.includes('ID') && line.includes('EXT'));
                if (headerLine) {
                    // The next non-empty line should have a format
                    for (let i = formatLines.indexOf(headerLine) + 1; i < formatLines.length; i++) {
                        if (formatLines[i].trim() && !formatLines[i].startsWith('-')) {
                            const firstField = formatLines[i].trim().split(/\s+/)[0];
                            if (firstField) {
                                bestFormatId = firstField;
                                console.log(`Extracted format ID from table: ${bestFormatId}`);
                                break;
                            }
                        }
                    }
                }
            }

            // If we have a format ID, try to download with it
            if (bestFormatId) {
                console.log(`Using format ID: ${bestFormatId} with URL: ${workingUrl}`);
                const outputPath = path.join(outputDir, `${videoId}.download`);

                try {
                    // Use the specific format ID with the URL that worked
                    const downloadCmd = `yt-dlp -f ${bestFormatId} -o "${outputPath}" ${workingUrl}`;
                    console.log(`Running command: ${downloadCmd}`);
                    await execAsync(downloadCmd);

                    // Check if download succeeded
                    if (fs.existsSync(outputPath)) {
                        console.log(`Successfully downloaded with format ID: ${bestFormatId}`);

                        // Check for captions first
                        try {
                            const captionsTranscript = await this.extractExistingCaptions(videoId, workingUrl, outputDir);
                            if (captionsTranscript && captionsTranscript.length > 0) {
                                console.log(`Found captions for ${workingUrl}`);
                                this.cleanupTempFiles(outputDir);
                                return captionsTranscript;
                            }
                        } catch (error) {
                            console.log(`No captions found for ${workingUrl}: ${error.message}`);
                        }

                        // If no captions, extract audio and transcribe
                        // Update the FFmpeg execution part with proper typing
                        if (this.ffmpegAvailable) {
                            const wavPath = path.join(outputDir, `${videoId}.wav`);
                            try {
                                console.log(`Extracting audio to WAV format at ${wavPath}`);

                                // Let's try a simpler FFmpeg command that might be more reliable
                                // The -t 7200 parameter limits to 2hrs
                                const ffmpegCmd = `ffmpeg -y -i "${outputPath}" -t 7200 -ar 16000 -ac 1 -c:a pcm_s16le "${wavPath}"`;
                                console.log(`Executing simplified FFmpeg command: ${ffmpegCmd}`);

                                // Setup a manual timeout with explicit type handling
                                let ffmpegProcess: { stdout: string, stderr: string } | null = null;
                                let timeoutReached = false;

                                try {
                                    // Start the ffmpeg process with a timeout
                                    const timeoutMs = 360000; // 6 minutes
                                    const timeoutPromise = new Promise<never>((_, reject) => {
                                        setTimeout(() => {
                                            timeoutReached = true;
                                            reject(new Error(`FFmpeg process timed out after ${timeoutMs / 1000} seconds`));
                                        }, timeoutMs);
                                    });

                                    // Execute the FFmpeg command
                                    const execPromise = execAsync(ffmpegCmd, {
                                        maxBuffer: 10 * 1024 * 1024 // 10MB buffer
                                    });

                                    // Race the two promises
                                    ffmpegProcess = await Promise.race([execPromise, timeoutPromise]) as { stdout: string, stderr: string };
                                    console.log(`FFmpeg command completed successfully`);

                                    // Now we can safely access stderr
                                    if (ffmpegProcess && ffmpegProcess.stderr) {
                                        console.log(`FFmpeg stderr output (last 500 chars): ${ffmpegProcess.stderr.slice(-500)}`);
                                    }
                                } catch (execError) {
                                    // Handle timeout or execution error
                                    if (timeoutReached) {
                                        console.error(`FFmpeg timed out after 3 minutes`);

                                        // Try to kill the FFmpeg process
                                        try {
                                            await execAsync(`pkill -f "ffmpeg.*${path.basename(outputPath)}"`);
                                            console.log(`Killed FFmpeg process after timeout`);
                                        } catch (killError) {
                                            console.warn(`Error killing FFmpeg process: ${killError.message}`);
                                        }
                                    } else {
                                        console.error(`FFmpeg execution error: ${execError.message}`);
                                    }

                                    // Check if the WAV file was partially created and is usable
                                    if (fs.existsSync(wavPath) && fs.statSync(wavPath).size > 1000) {
                                        console.log(`Partial WAV file created, will attempt to use it`);
                                    } else {
                                        // If no usable WAV file, try AssemblyAI directly
                                        if (process.env.ASSEMBLYAI_API_KEY) {
                                            console.log(`Attempting to use AssemblyAI directly with the downloaded file`);
                                            try {
                                                const transcriptionResult = await this.transcribeAudio(outputPath,
                                                    { ...options, provider: 'assemblyai' },
                                                    videoId
                                                );
                                                console.log(`Direct AssemblyAI transcription succeeded, result length: ${transcriptionResult.length}`);
                                                this.cleanupTempFiles(outputDir);
                                                return transcriptionResult;
                                            } catch (directError) {
                                                console.error(`Direct AssemblyAI transcription failed: ${directError.message}`);
                                                throw directError;
                                            }
                                        } else {
                                            throw execError;
                                        }
                                    }
                                }

                                // Check if the WAV file exists and log its size
                                if (fs.existsSync(wavPath)) {
                                    const stats = fs.statSync(wavPath);
                                    console.log(`WAV file created successfully: ${wavPath} (${Math.round(stats.size / 1024)}KB)`);

                                    // Check if the file is not empty and has a reasonable size
                                    if (stats.size < 1000) {  // Less than 1KB is probably empty/corrupt
                                        console.error(`Error: WAV file is too small (${stats.size} bytes)`);
                                        throw new Error(`FFmpeg created an unusable WAV file`);
                                    }

                                    console.log(`Starting transcription process for WAV file: ${wavPath}`);
                                    try {
                                        // Explicitly call transcribeAudio with proper error handling
                                        const transcriptionResult = await this.transcribeAudio(wavPath, options, videoId);
                                        console.log(`Transcription completed, result length: ${transcriptionResult.length} characters`);
                                        this.cleanupTempFiles(outputDir);
                                        return transcriptionResult;
                                    } catch (transcriptionError) {
                                        console.error(`Transcription error: ${transcriptionError.message}`);
                                        console.error(transcriptionError.stack);

                                        // Try fallback to AssemblyAI if transcription fails and it's not already the provider
                                        if (options.provider !== 'assemblyai' && process.env.ASSEMBLYAI_API_KEY) {
                                            console.log(`Attempting AssemblyAI fallback for transcription`);
                                            try {
                                                const fallbackResult = await this.transcribeAudio(wavPath,
                                                    { ...options, provider: 'assemblyai' },
                                                    videoId
                                                );
                                                console.log(`AssemblyAI fallback transcription succeeded, length: ${fallbackResult.length}`);
                                                this.cleanupTempFiles(outputDir);
                                                return fallbackResult;
                                            } catch (fallbackError) {
                                                console.error(`AssemblyAI fallback also failed: ${fallbackError.message}`);
                                            }
                                        }

                                        throw transcriptionError; // Re-throw to be caught by outer catch block
                                    }
                                } else {
                                    console.error(`Error: WAV file was not created at ${wavPath}`);

                                    // Try direct AssemblyAI transcription with the downloaded file as final fallback
                                    if (fs.existsSync(outputPath) && options.provider !== 'assemblyai' && process.env.ASSEMBLYAI_API_KEY) {
                                        console.log(`Attempting direct AssemblyAI transcription with downloaded file`);
                                        try {
                                            const directResult = await this.transcribeAudio(outputPath,
                                                { ...options, provider: 'assemblyai' },
                                                videoId
                                            );
                                            console.log(`Direct AssemblyAI transcription succeeded, length: ${directResult.length}`);
                                            this.cleanupTempFiles(outputDir);
                                            return directResult;
                                        } catch (directError) {
                                            console.error(`Direct AssemblyAI transcription failed: ${directError.message}`);
                                        }
                                    }

                                    throw new Error(`FFmpeg did not create the expected WAV file`);
                                }
                            } catch (error) {
                                console.error(`Error in audio extraction/transcription process:`, error);

                                // Check if this is a timeout error
                                if (error.message && error.message.includes('timed out')) {
                                    console.error(`FFmpeg process timed out. File may be too large or conversion is too slow.`);
                                }

                                // Add the error stack trace for more context
                                if (error.stack) {
                                    console.error(error.stack);
                                }

                                // Try direct AssemblyAI transcription with the downloaded file as last resort
                                if (fs.existsSync(outputPath) && options.provider !== 'assemblyai' && process.env.ASSEMBLYAI_API_KEY) {
                                    console.log(`Last resort: Attempting AssemblyAI with downloaded file`);
                                    try {
                                        const lastResortResult = await this.transcribeAudio(outputPath,
                                            { ...options, provider: 'assemblyai' },
                                            videoId
                                        );
                                        console.log(`Last resort transcription succeeded, length: ${lastResortResult.length}`);
                                        this.cleanupTempFiles(outputDir);
                                        return lastResortResult;
                                    } catch (lastError) {
                                        console.error(`Last resort transcription also failed: ${lastError.message}`);
                                    }
                                }

                                throw error; // Re-throw to be caught by the outer try/catch
                            }
                        }

                        // If we couldn't extract audio or transcribe, return a message
                        return `Successfully downloaded the Rumble video, but could not extract audio for transcription.`;
                    } else {
                        console.log(`File not found after download: ${outputPath}`);
                    }
                } catch (error) {
                    console.log(`Failed to download with format ID ${bestFormatId}: ${error.message}`);
                }
            }

            // Fall back to trying common format IDs that often work with Rumble
            const commonFormatIds = ['mp4-360p-0', 'mp4-180p'];

            for (const formatId of commonFormatIds) {
                const outputPath = path.join(outputDir, `${videoId}.download`);

                try {
                    console.log(`Trying common format ID: ${formatId} with URL: ${workingUrl}`);
                    const downloadCmd = `yt-dlp -f ${formatId} -o "${outputPath}" ${workingUrl}`;
                    await execAsync(downloadCmd);

                    if (fs.existsSync(outputPath)) {
                        console.log(`Successfully downloaded with common format ID: ${formatId}`);

                        // Extract audio and transcribe - using the improved FFmpeg command
                        if (this.ffmpegAvailable) {
                            const wavPath = path.join(outputDir, `${videoId}.wav`);
                            try {
                                console.log(`Extracting audio with FFmpeg (fallback flow)`);
                                const ffmpegCmd = `ffmpeg -i "${outputPath}" -ar 16000 -ac 1 -c:a pcm_s16le "${wavPath}"`;
                                console.log(`Executing FFmpeg command: ${ffmpegCmd}`);

                                // Use timeout and increased buffer size here too
                                const ffmpegResult = await execAsync(ffmpegCmd, {
                                    timeout: 300000, // 5 minute timeout
                                    maxBuffer: 10 * 1024 * 1024 // 10MB buffer
                                });

                                console.log(`FFmpeg fallback completed: ${ffmpegResult.stdout ? ffmpegResult.stdout.substring(0, 200) : 'no stdout'}`);

                                if (fs.existsSync(wavPath)) {
                                    const stats = fs.statSync(wavPath);
                                    console.log(`WAV file created (fallback flow): ${Math.round(stats.size / 1024)}KB`);

                                    // Transcribe the audio
                                    const transcriptionResult = await this.transcribeAudio(wavPath, options, videoId);
                                    console.log(`Fallback transcription completed, length: ${transcriptionResult.length} characters`);
                                    this.cleanupTempFiles(outputDir);
                                    return transcriptionResult;
                                } else {
                                    console.error(`Fallback WAV file not created: ${wavPath}`);
                                }
                            } catch (error) {
                                console.error(`Error in fallback audio extraction: ${error.message}`);

                                // Try direct AssemblyAI here too if FFmpeg fails
                                if (process.env.ASSEMBLYAI_API_KEY) {
                                    try {
                                        console.log(`Attempting last resort AssemblyAI with downloaded file`);
                                        const lastResult = await this.transcribeAudio(outputPath,
                                            { ...options, provider: 'assemblyai' },
                                            videoId
                                        );
                                        if (lastResult) {
                                            console.log(`Last resort AssemblyAI succeeded`);
                                            return lastResult;
                                        }
                                    } catch (lastError) {
                                        console.error(`Last resort AssemblyAI failed: ${lastError.message}`);
                                    }
                                }
                            }
                        }

                        return `Successfully downloaded the Rumble video, but could not extract audio for transcription.`;
                    }
                } catch (error) {
                    console.log(`Failed to download with common format ID ${formatId}: ${error.message}`);
                }
            }

            // If everything else failed
            return `Could not download this Rumble video. Format not available or video is restricted.`;
        } catch (error) {
            console.error(`Error in downloadAndTranscribe:`, error);

            if (error.message && error.message.includes('410')) {
                return "Video not found. This Rumble video appears to be unavailable or has been removed.";
            }

            return `Error downloading and transcribing: ${error.message}`;
        }
    }

    private async extractExistingCaptions(videoId: string, fullUrl: string, outputDir: string): Promise<string> {
        try {
            console.log(`Attempting to extract existing captions for ${videoId}`);

            // Try to download only captions
            const captionCmd = `yt-dlp --write-subs --skip-download --sub-langs all -o "${outputDir}/${videoId}" ${fullUrl}`;
            await execAsync(captionCmd);

            // Check if any subtitle files were downloaded
            const files = fs.readdirSync(outputDir);
            const subtitleFiles = files.filter(file =>
                file.endsWith('.vtt') ||
                file.endsWith('.srt') ||
                file.endsWith('.sbv')
            );

            if (subtitleFiles.length > 0) {
                // Found subtitle files - read and parse
                console.log(`Found ${subtitleFiles.length} subtitle files:`, subtitleFiles);

                // Read the first subtitle file (prefer .vtt if available)
                const vttFile = subtitleFiles.find(file => file.endsWith('.vtt'));
                const subtitleFile = vttFile || subtitleFiles[0];
                const subtitlePath = path.join(outputDir, subtitleFile);

                const subtitleContent = fs.readFileSync(subtitlePath, 'utf8');
                const parsedContent = this.parseSubtitleFile(subtitleContent, subtitleFile);

                console.log(`Successfully extracted transcript from ${subtitleFile}`);
                return parsedContent;
            }

            console.log(`No subtitle files found for ${videoId}`);
            return '';

        } catch (error) {
            console.error(`Error extracting captions: ${error}`);
            return '';
        }
    }


    private parseSubtitleFile(content: string, filename: string): string {
        const ext = path.extname(filename).toLowerCase();

        switch (ext) {
            case '.vtt':
                return this.parseVTT(content);
            case '.srt':
                return this.parseSRT(content);
            default:
                // For other formats, attempt a generic parsing
                return this.parseGenericSubtitles(content);
        }
    }

    private parseVTT(content: string): string {
        // Remove WEBVTT header and styling
        let lines = content.split('\n');
        let result = '';
        let isTimestamp = false;

        // Skip WEBVTT header
        let startIndex = lines.findIndex(line => line.trim() === 'WEBVTT');
        if (startIndex !== -1) {
            lines = lines.slice(startIndex + 1);
        }

        for (const line of lines) {
            const trimmed = line.trim();

            // Skip empty lines and numeric identifiers
            if (trimmed === '' || /^\d+$/.test(trimmed)) {
                continue;
            }

            // Skip timestamp lines
            if (trimmed.includes('-->')) {
                isTimestamp = true;
                continue;
            }

            // Skip style blocks
            if (trimmed.startsWith('STYLE') || trimmed.startsWith('NOTE')) {
                continue;
            }

            // If not a timestamp and not empty, it's actual content
            if (trimmed !== '') {
                if (isTimestamp) {
                    result += trimmed + ' ';
                    isTimestamp = false;
                } else {
                    // If it's a continuation of previous line, don't add extra spaces
                    result += trimmed + ' ';
                }
            }
        }

        return result.trim();
    }

    private parseSRT(content: string): string {
        let lines = content.split('\n');
        let result = '';
        let isTimestamp = false;

        for (const line of lines) {
            const trimmed = line.trim();

            // Skip empty lines and numeric identifiers
            if (trimmed === '' || /^\d+$/.test(trimmed)) {
                continue;
            }

            // Skip timestamp lines
            if (trimmed.includes('-->')) {
                isTimestamp = true;
                continue;
            }

            // If not a timestamp and not empty, it's actual content
            if (trimmed !== '') {
                if (isTimestamp) {
                    result += trimmed + ' ';
                    isTimestamp = false;
                } else {
                    result += trimmed + ' ';
                }
            }
        }

        return result.trim();
    }

    private parseGenericSubtitles(content: string): string {
        // A more generic approach for unknown formats
        // Strip out anything that looks like timestamps or IDs
        let lines = content.split('\n');
        let result = '';

        for (const line of lines) {
            const trimmed = line.trim();

            // Skip empty lines
            if (trimmed === '') continue;

            // Skip lines that look like timestamps (00:00:00,000 --> 00:00:00,000)
            if (trimmed.match(/\d+:\d+:\d+[.,]\d+ *--> *\d+:\d+:\d+[.,]\d+/)) continue;

            // Skip lines that are just numbers (likely IDs)
            if (/^\d+$/.test(trimmed)) continue;

            // Add content lines
            result += trimmed + ' ';
        }

        return result.trim();
    }

    private async getMetadata(videoId: string, fullUrl: string): Promise<string> {
        try {
            console.log(`Getting metadata for Rumble video: ${videoId}`);

            // Check if yt-dlp is available
            if (this.ytDlpAvailable) {
                // Generate unique output path
                const outputDir = path.join(this.tempDir, videoId);
                if (!fs.existsSync(outputDir)) {
                    fs.mkdirSync(outputDir, { recursive: true });
                }

                // Use yt-dlp to extract metadata
                const metadataCmd = `yt-dlp --skip-download --dump-json ${fullUrl}`;
                const metadataResult = await execAsync(metadataCmd);

                try {
                    const metadata = JSON.parse(metadataResult.stdout);

                    // Format metadata in a more readable way
                    const formattedMetadata = {
                        id: metadata.id || videoId,
                        title: metadata.title || 'Unknown Title',
                        description: metadata.description || '',
                        uploader: metadata.uploader || metadata.channel || 'Unknown Uploader',
                        uploadDate: metadata.upload_date || 'Unknown',
                        duration: metadata.duration || 0,
                        viewCount: metadata.view_count || 0,
                        likeCount: metadata.like_count || 0,
                        thumbnailUrl: metadata.thumbnail || '',
                        url: fullUrl
                    };

                    // Clean up temporary directory
                    this.cleanupTempFiles(outputDir);

                    return JSON.stringify(formattedMetadata, null, 2);
                } catch (parseError) {
                    console.error(`Error parsing metadata: ${parseError}`);
                    // Continue to fallback method
                }
            }

            // Fallback: Try to extract basic metadata from HTML
            console.log(`Attempting to extract metadata from webpage for ${videoId}`);

            try {
                const response = await axios.get(fullUrl);
                const html = response.data;

                // Extract title
                const titleMatch = html.match(/<title>(.*?)<\/title>/);
                const title = titleMatch ? titleMatch[1].replace(' - Rumble', '') : 'Unknown Title';

                // Extract other metadata
                const descriptionMatch = html.match(/<meta[^>]*name="description"[^>]*content="([^"]*)"[^>]*>/);
                const description = descriptionMatch ? descriptionMatch[1] : '';

                const ogImageMatch = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]*)"[^>]*>/);
                const thumbnailUrl = ogImageMatch ? ogImageMatch[1] : '';

                // Basic metadata object
                const basicMetadata = {
                    id: videoId,
                    title,
                    description,
                    thumbnailUrl,
                    url: fullUrl,
                    note: 'Limited metadata available without yt-dlp'
                };

                return JSON.stringify(basicMetadata, null, 2);

            } catch (htmlError) {
                console.error(`Error extracting HTML metadata: ${htmlError}`);

                // Return minimal metadata if everything fails
                return JSON.stringify({
                    id: videoId,
                    title: 'Unknown Title',
                    url: fullUrl,
                    note: 'Failed to retrieve detailed metadata'
                }, null, 2);
            }

        } catch (error) {
            console.error(`Error in getMetadata: ${error}`);

            if (error.message && error.message.includes('410')) {
                return JSON.stringify({
                    id: videoId,
                    error: "Video not found. This Rumble video appears to be unavailable or has been removed."
                }, null, 2);
            }

            return JSON.stringify({
                id: videoId,
                error: `Failed to retrieve metadata: ${error.message}`
            }, null, 2);
        }
    }

    private async downloadVideo(videoId: string, fullUrl: string): Promise<string> {
        try {
            console.log(`Downloading video: ${videoId}`);

            // Generate unique output path based on videoId
            const outputDir = path.join(this.tempDir, videoId);
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
            }

            const outputPath = path.join(outputDir, `${videoId}.mp4`);
            console.log(`Downloading to: ${outputPath}`);

            const downloadCmd = `yt-dlp -f "best[filesize<100M]" -o "${outputPath}" ${fullUrl}`;
            const downloadResult = await execAsync(downloadCmd);

            console.log(`Download completed: ${downloadResult.stdout}`);

            // Return the local path to the downloaded video
            return `Video downloaded successfully to: ${outputPath}`;

        } catch (error) {
            console.error(`Error in downloadVideo: ${error}`);

            if (error.message && error.message.includes('410')) {
                return "Video not found. This Rumble video appears to be unavailable or has been removed.";
            }

            return `Failed to download video: ${error.message}`;
        }
    }

    private cleanupTempFiles(directory: string, removeDir: boolean = true, keepFiles: string[] = []): void {
        try {
            if (fs.existsSync(directory)) {
                const files = fs.readdirSync(directory);
                for (const file of files) {
                    const filePath = path.join(directory, file);
                    // Skip files that should be kept
                    if (keepFiles.includes(filePath)) {
                        continue;
                    }
                    fs.unlinkSync(filePath);
                }
                if (removeDir) {
                    fs.rmdirSync(directory);
                }
            }
        } catch (error) {
            console.error('Error cleaning up temporary files:', error);
        }
    }




    private async transcribeAudio(audioPath: string, options: TranscriptionOptions = {}, videoId?: string): Promise<string> {
        try {
            console.log(`===== STARTING TRANSCRIPTION =====`);
            console.log(`Transcribing audio file: ${audioPath}`);

            // Check if the audio file exists and get its stats
            if (!fs.existsSync(audioPath)) {
                console.error(`Audio file not found: ${audioPath}`);
                throw new Error(`Audio file not found: ${audioPath}`);
            }

            const fileStats = fs.statSync(audioPath);
            const fileSizeBytes = fileStats.size;
            console.log(`Audio file exists and is ${(fileSizeBytes / (1024 * 1024)).toFixed(2)} MB in size`);

            if (fileSizeBytes === 0) {
                throw new Error(`Audio file is empty (0 bytes): ${audioPath}`);
            }

            // Determine which transcription method to use based on options or preferences
            const provider = options.provider || 'local-cuda'; // Default to local CUDA if available

            // Estimate transcription time
            const estimatedMinutes = this.estimateTranscriptionTime(fileSizeBytes, provider);
            console.log(`Estimated transcription time: ${estimatedMinutes} minutes with provider: ${provider}`);

            // Log in a special format for the CommandHandler to parse
            if (videoId) {
                console.log(`TRANSCRIPTION_ESTIMATE:${videoId}:${estimatedMinutes}`);
            }

            this.publishTranscriptionEstimate(videoId as string, fileSizeBytes, provider);

            // Send status update if callback is available
            if (this.statusCallback) {
                const readableProvider = provider === 'local-cuda' ? 'GPU (CUDA)' :
                    provider === 'local-cpu' ? 'CPU' :
                        provider.charAt(0).toUpperCase() + provider.slice(1);

                await this.statusCallback(`Transcribing ${(fileSizeBytes / (1024 * 1024)).toFixed(1)}MB audio using ${readableProvider}. Estimated time: ${estimatedMinutes} minutes.`);
            }

            // Use AssemblyAI if selected
            if (provider === 'assemblyai') {
                console.log('Using AssemblyAI for transcription');

                // Get API key from options or environment variable
                const apiKey = options.apiKey || process.env.ASSEMBLYAI_API_KEY;
                if (!apiKey) {
                    throw new Error('AssemblyAI API key not provided');
                }

                // Import the AssemblyAI SDK
                const { AssemblyAI } = require('assemblyai');
                const client = new AssemblyAI({
                    apiKey: apiKey
                });

                // For local files, we need to upload first
                // Fix the language code - AssemblyAI doesn't support 'auto'
                let languageCode = options.language || 'en';
                // If language is set to 'auto', default to 'en' for AssemblyAI
                if (languageCode === 'auto') {
                    console.log('AssemblyAI does not support automatic language detection. Using English (en) as default.');
                    languageCode = 'en';
                }

                // Set params with the corrected language code
                const params = {
                    audio: audioPath,
                    speaker_labels: true,
                    language_code: languageCode
                };

                // Perform the transcription
                console.log(`Calling AssemblyAI transcribe API with params:`, JSON.stringify(params, null, 2));
                const transcript = await client.transcripts.transcribe(params);
                console.log(`AssemblyAI transcription completed with status: ${transcript.status}`);

                // Check for errors
                if (transcript.status === 'error') {
                    throw new Error(`AssemblyAI transcription failed: ${transcript.error}`);
                }

                // Return the transcript text
                const resultText = transcript.text || 'Transcription produced no text.';
                console.log(`AssemblyAI returned transcript of length: ${resultText.length} characters`);
                return resultText;
            }

            // Use local Whisper if selected
            else if (provider === 'local-cuda' || provider === 'local-cpu') {
                console.log(`Using local Whisper (${provider}) for transcription`);

                // Verify whisper executable exists
                const whisperPath = '/usr/bin/whisper';
                if (!fs.existsSync(whisperPath)) {
                    console.error(`Whisper executable not found at path: ${whisperPath}`);
                    throw new Error(`Whisper executable not found at ${whisperPath}`);
                }
                console.log(`Whisper executable found at: ${whisperPath}`);

                // Try to detect the type of Whisper (OpenAI vs whisper.cpp)
                let whisperType = 'unknown';
                try {
                    console.log(`Checking Whisper version/type...`);
                    const { stdout, stderr } = await execAsync(`${whisperPath} --help`, { timeout: 5000 });
                    const output = stdout + stderr;

                    if (output.includes('--output_format') && output.includes('transcribe')) {
                        whisperType = 'openai';
                        console.log('Detected OpenAI Whisper');
                    } else if (output.includes('-m MODEL') && output.includes('-f FNAME')) {
                        whisperType = 'whisper.cpp';
                        console.log('Detected whisper.cpp');
                    } else {
                        console.log('Unknown Whisper type, output preview:', output.substring(0, 500));
                    }
                } catch (error) {
                    console.error(`Error detecting Whisper type:`, error);
                    // Continue with unknown type
                }

                // Prepare model path
                const modelSize = options.modelSize || 'medium';
                let modelPath;

                if (whisperType === 'whisper.cpp') {
                    // whisper.cpp uses ggml models
                    modelPath = path.join(process.cwd(), 'models', `ggml-${modelSize}.bin`);

                    // Check if model exists, download if necessary
                    if (!fs.existsSync(modelPath)) {
                        console.log(`Model file not found: ${modelPath}, downloading...`);
                        // Download code would go here, but we'll skip for now
                        console.log(`[Note: Model download not implemented, may cause issues]`);
                    }
                } else {
                    // OpenAI Whisper uses model names directly
                    modelPath = modelSize;
                    console.log(`Using OpenAI Whisper with model name: ${modelPath}`);
                }

                // Set up command based on detected Whisper type
                let whisperCmd;
                if (whisperType === 'whisper.cpp') {
                    // Command for whisper.cpp
                    const deviceFlag = provider === 'local-cuda' ? '--device cuda' : '';
                    whisperCmd = `${whisperPath} -m ${modelPath} -f "${audioPath}" ${deviceFlag}`;
                } else {
                    // Command for OpenAI Whisper
                    const deviceFlag = provider === 'local-cuda' ? '--device cuda' : '';
                    const langFlag = options.language && options.language !== 'auto'
                        ? `--language ${options.language}`
                        : '';

                    // For OpenAI Whisper, add output directory and format
                    const outputDir = path.dirname(audioPath);
                    whisperCmd = `${whisperPath} "${audioPath}" --model ${modelSize} ${deviceFlag} ${langFlag} --output_dir "${outputDir}" --output_format txt`;
                }

                console.log(`Executing whisper command: ${whisperCmd}`);

                try {
                    const { stdout, stderr } = await execAsync(whisperCmd, {
                        maxBuffer: 10 * 1024 * 1024,  // 10MB buffer
                        timeout: 0  // No timeout
                    });

                    if (stderr && stderr.trim()) {
                        console.warn('Whisper stderr output:', stderr);
                    }

                    if (stdout && stdout.trim()) {
                        console.log(`Whisper returned stdout of length: ${stdout.length} characters`);
                    } else {
                        console.log(`No stdout from Whisper command, checking for output files`);
                    }

                    // For OpenAI Whisper, check for output files
                    if (whisperType === 'openai' || whisperType === 'unknown') {
                        const outputDir = path.dirname(audioPath);
                        const baseName = path.basename(audioPath, path.extname(audioPath));
                        const possibleOutputFiles = [
                            path.join(outputDir, `${baseName}.txt`),
                            path.join(outputDir, `${baseName}.json`),
                            path.join(outputDir, `${baseName}.srt`),
                            path.join(outputDir, `${baseName}.vtt`)
                        ];

                        let outputContent = '';
                        for (const file of possibleOutputFiles) {
                            console.log(`Checking for output file: ${file}`);
                            if (fs.existsSync(file)) {
                                console.log(`Found output file: ${file}`);
                                try {
                                    outputContent = fs.readFileSync(file, 'utf8');
                                    console.log(`Read ${outputContent.length} characters from file`);
                                    break;
                                } catch (readError) {
                                    console.error(`Error reading output file:`, readError);
                                }
                            }
                        }

                        if (outputContent) {
                            return outputContent.trim();
                        }
                    }

                    // If we didn't find any output files, use stdout
                    const result = stdout.trim() || 'Transcription produced no text.';
                    console.log(`Using stdout result of length: ${result.length} characters`);
                    return result;
                } catch (whisperError) {
                    console.error('Error executing Whisper command:', whisperError);
                    if (whisperError.stderr) {
                        console.error('Whisper stderr:', whisperError.stderr);
                    }
                    if (whisperError.stdout) {
                        console.error('Whisper stdout:', whisperError.stdout);
                    }
                    throw whisperError;
                }
            }

            // Fallback or unsupported provider
            else {
                console.warn(`Unsupported transcription provider: ${provider}`);
                return `Audio file extracted: ${audioPath}. No suitable transcription method available for provider: ${provider}.`;
            }

        } catch (error) {
            console.error('Error transcribing audio:', error);
            console.error(error.stack); // Print stack trace for better debugging

            // Try fallback if original method fails
            if (options.provider !== 'assemblyai') {
                try {
                    console.log('Transcription failed, trying AssemblyAI as fallback...');

                    // Update status callback if available
                    if (this.statusCallback) {
                        await this.statusCallback('Transcription failed, switching to AssemblyAI as fallback...');
                    }

                    // Call recursively with AssemblyAI as provider
                    return await this.transcribeAudio(audioPath, {
                        ...options,
                        provider: 'assemblyai'
                    });
                } catch (fallbackError) {
                    console.error('Fallback transcription also failed:', fallbackError);
                    console.error(fallbackError.stack);
                }
            }

            return `Error transcribing audio: ${error.message}. Please try again later.`;
        }
    }

    // In RumbleTool.ts, add this new helper method
    // Add the setter method
    public setStatusCallback(callback: StatusCallback | null): void {
        this.statusCallback = callback;
    }
    /**
     * Estimates transcription time based on file size and provider
     * @param fileSizeBytes File size in bytes
     * @param provider Transcription provider being used
     * @returns Estimated time in minutes
     */
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
    private publishTranscriptionEstimate(videoId: string, fileSizeBytes: number, provider: string): void {
        try {
            const estimatedMinutes = this.estimateTranscriptionTime(fileSizeBytes, provider as TranscriptionProvider);

            // Store in the global map with a timestamp
            const estimate: TranscriptionEstimate = {
                videoId,
                estimatedMinutes,
                timestamp: Date.now()
            };

            (global as any).transcriptionEstimates = (global as any).transcriptionEstimates || new Map();
            (global as any).transcriptionEstimates.set(videoId, estimate);

            console.log(`[RumbleTool] Published transcription estimate: ${estimatedMinutes} minutes for ${videoId}`);
        } catch (error) {
            console.warn(`[RumbleTool] Error publishing estimate:`, error);
        }
    }

}
