// FormatConverter.ts

export class FormatConverter {
    static genericToHTML(content: string): string {
        // Handle headings first
        content = content.replace(/^### (.*$)/gm, '<b>$1</b>');  // H3 to bold
        content = content.replace(/^## (.*$)/gm, '<b>$1</b>');   // H2 to bold
        content = content.replace(/^# (.*$)/gm, '<b>$1</b>');    // H1 to bold

        // Convert other generic formatting to HTML
        content = content.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');  // Bold
        content = content.replace(/\*(.*?)\*/g, '<i>$1</i>');  // Italic
        content = content.replace(/^- (.*)$/gm, '• $1');  // Bullet points
        content = content.replace(/^(\d+)\. (.*)$/gm, '$1. $2');  // Numbered lists
        content = content.replace(/^> (.*)$/gm, '<i>$1</i>');  // Blockquotes to italic

        return content;
    }

    static genericToMarkdown(content: string): string {
        // Headings are already in correct Markdown format
        // Convert other generic formatting to Markdown
        content = content.replace(/\*\*(.*?)\*\*/g, '**$1**');  // Bold (already correct)
        content = content.replace(/\*(.*?)\*/g, '*$1*');  // Italic (already correct)
        content = content.replace(/^- (.*)$/gm, '- $1');  // Bullet points (already correct)
        content = content.replace(/^(\d+)\. (.*)$/gm, '$1. $2');  // Numbered lists (already correct)
        content = content.replace(/^> (.*)$/gm, '> $1');  // Blockquotes (already correct)

        return content;
    }
}