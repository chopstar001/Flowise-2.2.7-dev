// FileManager.ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import axios from 'axios';
import FormData from 'form-data';
import { createWriteStream } from 'fs';
import PDFDocument from 'pdfkit';
import { ContextAdapter } from './ContextAdapter';
import { getCredentialParam } from '../../../src/utils';


export class FileManager {
    private tempDir: string;
    private botToken: string | null;
    private botName: string | null;

    constructor(botToken: string | null = null, botName: string | null = null) {
        this.botToken = botToken;
        this.botName = botName; // Correctly assign the parameter to the property

        // Create a directory for temporary files
        this.tempDir = path.join(os.tmpdir(), 'telegram-bot-files');
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
        console.log(`FileManager initialized with temp directory: ${this.tempDir}`);
    }

    private getBotToken(): string | null {
        // First try the token passed in constructor
        if (this.botToken) return this.botToken;

        // Fall back to environment variable if needed
        return process.env.TELEGRAM_BOT_TOKEN || null;
    }

    private getBotName(): string | null {
        return this.botName || 'Telegram Bot'; // Provide a default name if botName is null
    }

    /**
     * Creates a text file from content and sends it via Telegram
     */
    // In FileManager.ts - update saveAndSendAsText
    public async saveAndSendAsText(
        adapter: ContextAdapter,
        content: string,
        filename: string
    ): Promise<void> {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const safeFilename = this.sanitizeFilename(filename);
        const fullFilename = `${safeFilename}_${timestamp}.txt`;
        const filePath = path.join(this.tempDir, fullFilename);

        try {
            // Write content to file
            fs.writeFileSync(filePath, content, 'utf8');
            console.log(`Created text file: ${filePath}`);

            // Get the bot token
            const token = this.getBotToken();
            if (!token) {
                throw new Error('Telegram bot token not found');
            }

            // Get chat ID from context
            const chatId = adapter.getMessageContext().chatId;
            if (!chatId) {
                throw new Error('Chat ID not available');
            }

            // Create form data
            const formData = new FormData();
            formData.append('chat_id', chatId);
            formData.append('document', fs.createReadStream(filePath));
            formData.append('caption', `📄 Saved content: ${safeFilename}`);

            // Send directly via Telegram API
            console.log(`Sending document via direct API call, chat ID: ${chatId}`);
            const response = await axios.post(
                `https://api.telegram.org/bot${token}/sendDocument`,
                formData,
                { headers: formData.getHeaders() }
            );

            if (response.data && response.data.ok) {
                console.log(`Successfully sent document via API: ${JSON.stringify(response.data.result)}`);
            } else {
                console.warn(`API response not ok: ${JSON.stringify(response.data)}`);
                // Fall back to sending file path
                await adapter.reply(`📄 File created: ${filePath}`);
            }

            // Clean up the file after a reasonable delay
            this.scheduleCleanup(filePath, 600000); // 10 minutes
        } catch (error) {
            console.error(`Error in saveAndSendAsText:`, error);
            // Send file path as fallback
            await adapter.reply(`📄 File created: ${filePath} (could not send directly: ${error.message})`);
        }
    }

    // Similarly for PDF
    public async saveAndSendAsPDF(
        adapter: ContextAdapter,
        content: string,
        filename: string,
        title?: string,
        options: { includeTOC?: boolean } = {}
    ): Promise<void> {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const safeFilename = this.sanitizeFilename(filename);
        const fullFilename = `${safeFilename}_${timestamp}.pdf`;
        const filePath = path.join(this.tempDir, fullFilename);

        try {
            // Create PDF
            await this.createPDF(content, filePath, title || filename, options);
            console.log(`Created PDF file: ${filePath}`);

            // Get the bot token
            const token = this.getBotToken();
            if (!token) {
                throw new Error('Telegram bot token not found');
            }

            // Get chat ID from context
            const chatId = adapter.getMessageContext().chatId;
            if (!chatId) {
                throw new Error('Chat ID not available');
            }

            // Create form data
            const formData = new FormData();
            formData.append('chat_id', chatId);
            formData.append('document', fs.createReadStream(filePath));
            formData.append('caption', `📑 PDF document: ${safeFilename}`);

            // Send directly via Telegram API
            console.log(`Sending PDF via direct API call, chat ID: ${chatId}`);
            const response = await axios.post(
                `https://api.telegram.org/bot${token}/sendDocument`,
                formData,
                { headers: formData.getHeaders() }
            );

            if (response.data && response.data.ok) {
                console.log(`Successfully sent PDF via API: ${JSON.stringify(response.data.result)}`);
            } else {
                console.warn(`API response not ok: ${JSON.stringify(response.data)}`);
                // Fall back to sending file path
                await adapter.reply(`📑 PDF file created: ${filePath}`);
            }

            // Clean up the file
            this.scheduleCleanup(filePath, 600000); // 10 minutes
        } catch (error) {
            console.error(`Error in saveAndSendAsPDF:`, error);
            // Send file path as fallback
            await adapter.reply(`📑 PDF file created: ${filePath} (could not send directly: ${error.message})`);
        }
    }


    public async saveAndSendTranscript(
        adapter: ContextAdapter,
        content: string,
        videoId: string,
        source: 'youtube' | 'rumble'
    ): Promise<void> {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const sourcePrefix = source === 'youtube' ? 'yt' : 'rumble';
        const safeFilename = `${sourcePrefix}_transcript_${this.sanitizeFilename(videoId)}_${timestamp}`;

        // Format the transcript for better readability
        const formattedContent = this.formatTranscript(content, videoId, source);

        // First attempt to send as a text file
        try {
            await this.saveAndSendAsText(adapter, formattedContent, safeFilename);
        } catch (error) {
            console.error(`Error sending transcript as text: ${error.message}`);

            // If text file fails, try sending as PDF
            try {
                await this.saveAndSendAsPDF(adapter, formattedContent, safeFilename, `${source.toUpperCase()} Transcript: ${videoId}`);
            } catch (pdfError) {
                console.error(`Error sending transcript as PDF: ${pdfError.message}`);

                // Last resort - send a message with the error and instructions
                await adapter.reply(
                    `❌ Unable to send full transcript due to an error. You can access the transcript through the pattern processing menu by clicking "Use raw_rumble_data" option.`
                );
            }
        }
    }

    /**
    * Format transcript content for better readability
    */
    private formatTranscript(content: string, videoId: string, source: 'youtube' | 'rumble'): string {
        // Add a header with video information
        const header = `# Transcript: ${source.toUpperCase()} Video ${videoId}\n` +
            `Retrieved: ${new Date().toLocaleString()}\n\n` +
            `Source: ${source === 'youtube' ? 'YouTube' : 'Rumble'}\n` +
            `Video ID: ${videoId}\n\n` +
            `${'='.repeat(80)}\n\n`;

        // Clean up any problematic formatting in the content
        let cleanedContent = content
            .replace(/\r\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n');

        // If content has timestamps (in format [00:00:00 - 00:00:00]), enhance the formatting
        if (content.match(/\[\d{2}:\d{2}:\d{2} - \d{2}:\d{2}:\d{2}\]/)) {
            cleanedContent = cleanedContent.replace(
                /\[(\d{2}:\d{2}:\d{2}) - (\d{2}:\d{2}:\d{2})\] (.*?)(?=\n\[|$)/gs,
                '## [$1 - $2]\n$3\n'
            );
        }

        return header + cleanedContent;
    }


    private parseContentSections(content: string): Array<{
        type: string;
        content: string;
        number?: number;
    }> {
        const lines = content.split('\n');
        const sections = [];
        let currentList: { type: string, items: string[] } | null = null;
        let numberedListIndex = 1;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // Skip empty lines
            if (!line) {
                // End any current list
                if (currentList) {
                    // Process and add all items from the current list
                    currentList.items.forEach((item, index) => {
                        if (currentList?.type === 'numbered-list') {
                            sections.push({
                                type: 'numbered-item',
                                content: item,
                                number: index + 1
                            });
                        } else {
                            sections.push({
                                type: 'list-item',
                                content: item
                            });
                        }
                    });
                    currentList = null;
                    numberedListIndex = 1;
                }
                continue;
            }

            // Remove "###" prefixes from section headers
            if (line.startsWith('###')) {
                sections.push({
                    type: 'heading',
                    content: line.substring(3).trim()
                });
            }
            // Check for headings
            else if (line.startsWith('# ')) {
                sections.push({
                    type: 'heading',
                    content: line.substring(2)
                });
            }
            else if (line.startsWith('## ') || line.startsWith('Key ') || line.startsWith('Main ') || line.startsWith('Overall ') || line.startsWith('Target ')) {
                sections.push({
                    type: 'subheading',
                    content: line.replace(/^## /, '')
                });
            }
            // Check for list items
            else if (line.startsWith('- ') || line.startsWith('• ') || line.startsWith('* ')) {
                const item = line.substring(2);
                if (!currentList || currentList.type !== 'bullet-list') {
                    currentList = { type: 'bullet-list', items: [] };
                }
                currentList.items.push(item);
            }
            // Check for numbered list items
            else if (/^\d+\.\s/.test(line)) {
                const item = line.replace(/^\d+\.\s/, '');
                if (!currentList || currentList.type !== 'numbered-list') {
                    currentList = { type: 'numbered-list', items: [] };
                    numberedListIndex = 1;
                }
                currentList.items.push(item);
                numberedListIndex++;
            }
            // Check for quotes
            else if (line.startsWith('>') || line.startsWith('"') || line.includes(':"') || line.startsWith('"')) {
                sections.push({
                    type: 'quote',
                    content: line.replace(/^>/, '').replace(/^"/, '').replace(/"$/, '').replace(/^"/, '').replace(/"$/, '').trim()
                });
            }
            // Regular paragraph
            else {
                sections.push({
                    type: 'paragraph',
                    content: line
                });
            }
        }

        // Process any remaining list items
        if (currentList) {
            currentList.items.forEach((item, index) => {
                if (currentList?.type === 'numbered-list') {
                    sections.push({
                        type: 'numbered-item',
                        content: item,
                        number: index + 1
                    });
                } else {
                    sections.push({
                        type: 'list-item',
                        content: item
                    });
                }
            });
        }

        return sections;
    }

    private addSimpleFormattedContent(doc: PDFKit.PDFDocument, sections: Array<{
        type: string;
        content: string;
        number?: number;
    }>): void {
        // Add each section with appropriate formatting
        let previousType = '';

        for (const section of sections) {
            // Add extra spacing between different section types for better readability
            if (previousType && previousType !== section.type) {
                // Add more space between major sections
                if ((previousType === 'heading' || section.type === 'heading') ||
                    (previousType.includes('item') && !section.type.includes('item'))) {
                    doc.moveDown(1);
                } else {
                    doc.moveDown(0.5);
                }
            }

            switch (section.type) {
                case 'heading':
                    doc.moveDown()
                        .fontSize(18)
                        .text(section.content, {
                            align: 'left'
                        });
                    break;

                case 'subheading':
                    doc.moveDown(0.5)
                        .fontSize(16)
                        .text(section.content, {
                            align: 'left'
                        });
                    break;

                case 'list-item':
                    doc.fontSize(12)
                        .text(`• ${section.content}`, {
                            align: 'left',
                            indent: 20
                        });
                    break;

                case 'numbered-item':
                    doc.fontSize(12)
                        .text(`${section.number}. ${section.content}`, {
                            align: 'left',
                            indent: 20
                        });
                    break;

                case 'paragraph':
                    doc.fontSize(12)
                        .text(section.content, {
                            align: 'left'
                        });
                    break;

                case 'quote':
                    doc.fontSize(12)
                        .text(`"${section.content}"`, {
                            align: 'left',
                            indent: 30
                        });
                    break;
            }

            previousType = section.type;
        }
    }

    private createPDF(content: string, filePath: string, title: string, options: { includeTOC?: boolean } = {}): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                // Get bot name
                const botName = this.getBotName() || 'Telegram Bot';

                // Setup document with page event handling for footers
                const doc = new PDFDocument({
                    margin: 50,
                    bufferPages: true,  // Important for page numbering
                    info: {
                        Title: title,
                        Author: botName,
                        Subject: 'Generated Document',
                        CreationDate: new Date()
                    }
                });

                // Create file write stream
                const stream = createWriteStream(filePath);
                stream.on('error', reject);
                stream.on('finish', () => resolve());
                doc.pipe(stream);

                // Add a simple header/title page
                this.addSimplePDFHeader(doc, title);

                // Parse content into sections
                const sections = this.parseContentSections(content);

                // Only add TOC if requested and document has enough sections
                if (options.includeTOC && sections.filter(s => s.type === 'heading' || s.type === 'subheading').length > 3) {
                    this.addSimpleTableOfContents(doc, sections);
                }

                // Process and add formatted content
                this.addSimpleFormattedContent(doc, sections);

                // Add page numbers at the bottom of each page
                const range = doc.bufferedPageRange();
                for (let i = 0; i < range.count; i++) {
                    doc.switchToPage(i);

                    // Save current y position
                    const currentY = doc.y;

                    // Go to bottom of page
                    const bottomY = doc.page.height - 50;

                    // Add page number
                    doc.fontSize(10)
                        .text(
                            `Page ${i + 1} of ${range.count}`,
                            doc.page.margins.left,
                            bottomY,
                            { align: 'center', width: doc.page.width - (doc.page.margins.left + doc.page.margins.right) }
                        );

                    // Restore position
                    doc.y = currentY;
                }

                // Finalize PDF
                doc.end();
            } catch (error) {
                reject(error);
            }
        });
    }

    // Simplified versions of methods that don't try to use custom fonts
    private addSimplePDFHeader(doc: PDFKit.PDFDocument, title: string): void {
        // Title
        doc.fontSize(24)
            .text(title, {
                align: 'center'
            });

        doc.moveDown();

        // Add timestamp and document info
        doc.fontSize(12)
            .text(`Generated: ${new Date().toLocaleString()}`, {
                align: 'center'
            });

        doc.moveDown(2);

        // Add a separator line
        doc.moveTo(50, doc.y)
            .lineTo(doc.page.width - 50, doc.y)
            .stroke();

        doc.moveDown(2);
    }

    private addSimpleTableOfContents(doc: PDFKit.PDFDocument, sections: Array<{ type: string, content: string }>): void {
        doc.fontSize(18)
            .text('Table of Contents', {
                align: 'center'
            });

        doc.moveDown();

        // Generate TOC entries
        for (const section of sections) {
            if (section.type === 'heading') {
                doc.fontSize(12)
                    .text(section.content, {
                        indent: 0
                    });
            } else if (section.type === 'subheading') {
                doc.fontSize(10)
                    .text(`   ${section.content}`, {
                        indent: 10
                    });
            }
        }

        doc.moveDown(2);
        doc.addPage();
    }

    // Add a nice header/title page
    private addPDFHeader(doc: PDFKit.PDFDocument, title: string): void {
        // Add logo if you have one
        /* 
        if (fs.existsSync('./assets/logo.png')) {
            doc.image('./assets/logo.png', {
                fit: [250, 100],
                align: 'center'
            });
            doc.moveDown(2);
        }
        */

        // Add title
        doc.fontSize(24)
            .fillColor('#333333')
            .font('Helvetica-Bold')
            .text(title, {
                align: 'center'
            });

        doc.moveDown();

        // Add timestamp and document info
        doc.fontSize(12)
            .fillColor('#666666')
            .font('Helvetica')
            .text(`Generated: ${new Date().toLocaleString()}`, {
                align: 'center'
            });

        doc.moveDown(2);

        // Add a separator line
        doc.moveTo(50, doc.y)
            .lineTo(doc.page.width - 50, doc.y)
            .stroke('#cccccc');

        doc.moveDown(2);
    }

    // Process content and add it with appropriate formatting
    private addFormattedContent(doc: PDFKit.PDFDocument, sections: Array<{
        type: string;
        content: string;
        number?: number;
    }>): void {
        const FONTS = {
            normal: 'Helvetica',
            bold: 'Helvetica-Bold',
            italic: 'Helvetica' // Use regular Helvetica instead of Italic
        };

        // Add each section with appropriate formatting
        for (const section of sections) {
            switch (section.type) {
                case 'heading':
                    doc.moveDown()
                        .fontSize(18)
                        .font(FONTS.bold)  // Use constant
                        .fillColor('#333333')
                        .text(section.content, {
                            align: 'left'
                        });
                    doc.moveDown(0.5);
                    break;

                case 'subheading':
                    doc.moveDown(0.5)
                        .fontSize(16)
                        .font(FONTS.bold)  // Use constant
                        .fillColor('#444444')
                        .text(section.content, {
                            align: 'left'
                        });
                    doc.moveDown(0.5);
                    break;

                // ... and so on for other section types

                case 'quote':
                    doc.moveDown(0.5)
                        .fontSize(12)
                        .font(FONTS.italic)  // Use constant
                        .fillColor('#555555')
                        .text(`"${section.content}"`, {
                            align: 'left',
                            indent: 30
                        });
                    doc.moveDown(0.5);
                    break;
            }
        }
    }
    // Add to FileManager.ts

    /**
     * Downloads a file from a URL to a local path
     * @param url The URL of the file to download
     * @param outputPath The local path to save the file to
     * @returns Promise that resolves when the download is complete
     */
    public async downloadFile(url: string, outputPath: string): Promise<void> {
        console.log(`Downloading file from ${url} to ${outputPath}`);

        return new Promise<void>((resolve, reject) => {
            // Make sure the directory exists
            const outputDir = path.dirname(outputPath);
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
            }

            // Create write stream
            const fileStream = fs.createWriteStream(outputPath);

            // Handle errors on the write stream
            fileStream.on('error', (error) => {
                console.error(`Error writing to file ${outputPath}:`, error);
                reject(error);
            });

            // Create an HTTP/HTTPS client based on the URL
            const client = url.startsWith('https') ? https : http;

            // Make the request
            const request = client.get(url, (response) => {
                // Check if response is success
                if (response.statusCode !== 200) {
                    const error = new Error(`Failed to download file, status code: ${response.statusCode}`);
                    fileStream.close();
                    fs.unlink(outputPath, () => { }); // Delete the file
                    return reject(error);
                }

                // Pipe the response to the file
                response.pipe(fileStream);

                // When download is complete
                fileStream.on('finish', () => {
                    fileStream.close();
                    console.log(`Successfully downloaded file to ${outputPath}`);
                    resolve();
                });
            });

            // Handle request errors
            request.on('error', (error) => {
                console.error(`Error downloading file from ${url}:`, error);
                fileStream.close();
                fs.unlink(outputPath, () => { }); // Delete the file
                reject(error);
            });

            // Set a timeout
            request.setTimeout(60000, () => {
                request.abort();
                fileStream.close();
                fs.unlink(outputPath, () => { }); // Delete the file
                reject(new Error('Download request timed out'));
            });
        });
    }

    private addTableOfContents(doc: PDFKit.PDFDocument, sections: Array<{ type: string, content: string }>): void {
        doc.fontSize(18)
            .font('Helvetica-Bold')
            .text('Table of Contents', {
                align: 'center'
            });

        doc.moveDown();

        let pageNumbers: { [heading: string]: number } = {};
        let currentPage = 1;

        // Calculate approximate page numbers
        let y = doc.y;
        for (const section of sections) {
            if (section.type === 'heading' || section.type === 'subheading') {
                pageNumbers[section.content] = currentPage;
            }

            // Roughly estimate content height
            const lineHeight = section.type === 'heading' ? 30 :
                section.type === 'subheading' ? 24 : 18;

            y += lineHeight;

            // Check if we need to advance to next page
            if (y > doc.page.height - doc.page.margins.bottom) {
                y = doc.page.margins.top;
                currentPage++;
            }
        }

        // Add TOC entries
        for (const section of sections) {
            if (section.type === 'heading') {
                doc.fontSize(12)
                    .font('Helvetica-Bold')
                    .text(section.content, {
                        continued: true
                    });

                doc.fontSize(12)
                    .font('Helvetica')
                    .text(`  Page ${pageNumbers[section.content]}`, {
                        align: 'right'
                    });
            } else if (section.type === 'subheading') {
                doc.fontSize(10)
                    .font('Helvetica')
                    .text(`   ${section.content}`, {
                        continued: true,
                        indent: 10
                    });

                doc.text(`  Page ${pageNumbers[section.content]}`, {
                    align: 'right'
                });
            }
        }

        doc.moveDown(2);
        doc.addPage();
    }
    // Add a footer to the PDF
    private addPDFFooter(doc: PDFKit.PDFDocument): void {
        // Don't try to switch pages; just add footer to current page
        const pageCount = doc.bufferedPageRange().count;

        // Save the current position
        const originalY = doc.y;

        // Go to the bottom of the page
        doc.page.margins.bottom = 50;
        doc.y = doc.page.height - doc.page.margins.bottom;

        // Add page number for current page
        doc.fontSize(10)
            .fillColor('#999999')
            .text(`Page ${pageCount} of ${pageCount}`, {
                align: 'center'
            });

        // Restore the original y position
        doc.y = originalY;
    }
    /**
     * Schedule cleanup of a temporary file
     */
    private scheduleCleanup(filePath: string, delayMs: number = 300000): void {
        // Delete file after delay (default 5 minutes)
        setTimeout(() => {
            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    console.log(`Cleaned up temporary file: ${filePath}`);
                }
            } catch (error) {
                console.error(`Error cleaning up file ${filePath}:`, error);
            }
        }, delayMs);
    }

    /**
     * Sanitize filename to prevent directory traversal and invalid characters
     */
    private sanitizeFilename(filename: string): string {
        // Replace invalid characters with underscores
        return filename
            .replace(/[/\\?%*:|"<>]/g, '_')
            .replace(/\s+/g, '_')
            .substring(0, 100); // Limit length
    }
}