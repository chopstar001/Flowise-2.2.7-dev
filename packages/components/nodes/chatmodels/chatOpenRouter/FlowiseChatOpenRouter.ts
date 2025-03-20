import { BaseChatModel, BaseChatModelParams } from '@langchain/core/language_models/chat_models'
import { BaseMessage, AIMessage, MessageContent, HumanMessage, SystemMessage } from '@langchain/core/messages'
import { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager'
import { getEnvironmentVariable } from '@langchain/core/utils/env'
import { BaseCache } from '@langchain/core/caches'
import { StructuredTool } from '@langchain/core/tools'
import { ChatResult, ChatGeneration, ChatGenerationChunk } from '@langchain/core/outputs';
import { RunnableInterface, type RunnableConfig } from '@langchain/core/runnables';
import { IMultiModalOption, IVisionChatModal } from '../../../src/Interface';
import axios from 'axios'

function safeStringify(obj: any, indent = 2): string {
    const cache = new Set<any>();
    const retVal = JSON.stringify(
        obj,
        (key, value) => {
            if (typeof value === "object" && value !== null) {
                if (cache.has(value)) {
                    return undefined; // Duplicate reference found, discard key
                }
                cache.add(value); // Store value in our collection
            }
            return value;
        },
        indent
    );
    return retVal;
}
export interface OpenRouterCallOptions extends RunnableConfig {
    // Add any additional options specific to OpenRouter if needed
}

export interface OpenRouterParams extends BaseChatModelParams {
    modelName: string;
    openRouterApiKey?: string;
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    streaming?: boolean;
    cache?: BaseCache;
    tools: StructuredTool[];
    id: string; // Add this line
}

export class ChatOpenRouter extends BaseChatModel<OpenRouterCallOptions> {
    modelName: string;
    openRouterApiKey?: string;
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    streaming?: boolean;
    cache?: BaseCache;
    tools: StructuredTool[];
    multiModalOption?: IMultiModalOption;
    configuredModel: string;
    configuredMaxToken: number;
    id: string;

    constructor(params: OpenRouterParams) {
        super(params);
        this.modelName = params.modelName;
        this.openRouterApiKey = params.openRouterApiKey ?? getEnvironmentVariable('OPENROUTER_API_KEY');
        this.temperature = params.temperature;
        this.maxTokens = params.maxTokens;
        this.topP = params.topP;
        this.streaming = params.streaming;
        this.cache = params.cache;
        this.tools = params.tools || [];
        this.id = params.id;
        this.configuredModel = params.modelName;
        this.configuredMaxToken = params.maxTokens || 4096;
    }


    _llmType() {
        return 'openrouter'
    }
    _modelType() {
        return 'chat-openrouter';
    }
    setVisionModel(): void {
        // OpenRouter doesn't have a specific vision model, so we'll just log this call
        console.log('ChatOpenRouter: setVisionModel called. Using the current model for vision tasks.');
    }

    revertToOriginalModel(): void {
        this.modelName = this.configuredModel;
        this.maxTokens = this.configuredMaxToken;
        console.log(`ChatOpenRouter: Reverted to original model: ${this.modelName}`);
    }

    setMultiModalOption(multiModalOption: IMultiModalOption): void {
        this.multiModalOption = multiModalOption;
        console.log('ChatOpenRouter: Multi-modal option set', multiModalOption);
    }

    async _generate(messages: BaseMessage[], options: this['ParsedCallOptions'], runManager?: CallbackManagerForLLMRun): Promise<ChatResult> {
        const url = 'https://openrouter.ai/api/v1/chat/completions';
        
        const formattedMessages = messages.map((message) => {
            let role: string;
            let content: MessageContent;

            if (message.getType() === 'human') {
                role = 'user';
            } else if (message.getType() === 'ai') {
                role = 'assistant';
            } else if (message.getType() === 'system') {
                role = 'system';
            } else {
                role = 'user'; // Default to 'user' if type is unknown
            }

            // Handle multi-modal content
            if (Array.isArray(message.content)) {
                content = message.content.map((item) => {
                    if (typeof item === 'string') {
                        return { type: 'text', text: item };
                    } else if ('image_url' in item) {
                        return {
                            type: 'image_url',
                            image_url: {
                                url: item.image_url.url,
                                detail: item.image_url.detail || 'auto'
                            }
                        };
                    }
                    // If it's already in the correct format, return as is
                    return item;
                });
            } else {
                content = message.content;
            }

            return { role, content };
        });
        
        const data: any = {
            model: this.modelName,
            messages: formattedMessages,
            temperature: this.temperature,
            max_tokens: this.maxTokens,
            top_p: this.topP,
            stream: this.streaming,
        };

        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.openRouterApiKey}`,
            'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'http://localhost:3000',
            'X-Title': 'Flowise',
        };

        // If cache is available, try to retrieve the response from cache
        if (this.cache) {
            const cacheKey = this.getCacheKey(messages, options)
            const cachedResponse = await this.cache.lookup(cacheKey, this._llmType())
            if (cachedResponse) {
                return {
                    generations: cachedResponse as ChatGeneration[],
                }
            }
        }
        if (this.tools && this.tools.length > 0) {
            data.tools = this.tools.map(tool => ({
                type: "function",
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.schema,
                },
            }));
        }
        
        try {
            console.log('Sending request to OpenRouter API:', safeStringify(data));
            console.log('Headers:', safeStringify(headers));
            
            const response = await axios.post(url, data, { 
                headers,
                responseType: 'stream'
            });
            
            let fullContent = '';
            let partialLine = '';
            for await (const chunk of response.data) {
                const lines = (partialLine + chunk.toString()).split('\n');
                partialLine = lines.pop() || '';

                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (trimmedLine === '') continue;
                    if (trimmedLine === 'data: [DONE]') break;
                    if (trimmedLine.startsWith('data: ')) {
                        try {
                            const jsonData = JSON.parse(trimmedLine.slice(6));
                            if (jsonData.choices && jsonData.choices[0].delta && jsonData.choices[0].delta.content) {
                                const content = jsonData.choices[0].delta.content;
                                fullContent += content;
                                if (runManager) {
                                    await runManager.handleLLMNewToken(content);
                                }
                            }
                        } catch (parseError) {
                            console.warn('Failed to parse JSON:', trimmedLine);
                        }
                    }
                }
            }

            console.log('Received full response from OpenRouter API:', fullContent);

            const generation: ChatGeneration = {
                text: fullContent,
                message: new AIMessage(fullContent),
            };
            return {
                generations: [generation],
            };
        } catch (error) {
            console.error('Error calling OpenRouter API:', error);
            if (axios.isAxiosError(error)) {
                console.error('Axios error details:', safeStringify(error.response?.data));
                console.error('Axios error status:', error.response?.status);
                console.error('Axios error headers:', safeStringify(error.response?.headers));
            }
            throw new Error(`Failed to generate response from OpenRouter: ${error.message}`);
        }
    }

    private getCacheKey(messages: BaseMessage[], options: this['ParsedCallOptions']): string {
        // Implement a method to generate a unique cache key based on messages and options
        return `${this.modelName}:${JSON.stringify(messages)}:${JSON.stringify(options)}`
    }
    bindTools(tools: StructuredTool[]): this {
        this.tools = tools;
        return this;
    }
    
}