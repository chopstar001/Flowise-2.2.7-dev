import { ICommonObject, INode, INodeData, INodeOptionsValue, INodeParams, IMultiModalOption } from '../../../src/Interface'
import { getBaseClasses, getCredentialData, getCredentialParam } from '../../../src/utils'
import { ChatOpenRouter, OpenRouterParams } from './FlowiseChatOpenRouter'
import { BaseCache } from '@langchain/core/caches'
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

const getFallbackModels = (): INodeOptionsValue[] => {
    return [
        { label: 'GPT-3.5 Turbo', name: 'openai/gpt-3.5-turbo' },
        { label: 'GPT-4', name: 'openai/gpt-4' },
        { label: 'Claude 2', name: 'anthropic/claude-2' },
        { label: 'PaLM 2', name: 'google/palm-2-chat-bison' },
        { label: 'Llama 2 70B', name: 'meta-llama/llama-2-70b-chat' },
    ]
}

class ChatOpenRouter_ChatModels implements INode {
    label: string
    name: string
    version: number
    type: string
    icon: string
    category: string
    description: string
    baseClasses: string[]
    credential: INodeParams
    inputs: INodeParams[]

    constructor() {
        this.label = 'ChatOpenRouter'
        this.name = 'chatOpenRouter'
        this.version = 1.0
        this.type = 'ChatOpenRouter'
        this.icon = 'openrouter.png'
        this.category = 'Chat Models'
        this.description = 'Wrapper around OpenRouter API for various large language models'
        this.baseClasses = [this.type, ...getBaseClasses(ChatOpenRouter)]
        this.credential = {
            label: 'Connect Credential',
            name: 'credential',
            type: 'credential',
            credentialNames: ['openRouterApi']
        }
        this.inputs = [
            {
                label: 'Cache',
                name: 'cache',
                type: 'BaseCache',
                optional: true
            },
            {
                label: 'Model Name',
                name: 'modelName',
                type: 'asyncOptions',
                loadMethod: 'listModels'
            },
            {
                label: 'Temperature',
                name: 'temperature',
                type: 'number',
                step: 0.1,
                default: 0.9,
                optional: true
            },
            {
                label: 'Max Tokens',
                name: 'maxTokens',
                type: 'number',
                step: 1,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Top Probability',
                name: 'topP',
                type: 'number',
                step: 0.1,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Streaming',
                name: 'streaming',
                type: 'boolean',
                default: true,
                optional: true
            },
            {
                label: 'Allow Image Uploads',
                name: 'allowImageUploads',
                type: 'boolean',
                description: 'Automatically uses vision-capable models when an image is uploaded from chat.',
                default: false,
                optional: true
            }
        ]
    }

    loadMethods = {
        async listModels(nodeData: INodeData, options?: ICommonObject): Promise<INodeOptionsValue[]> {
            const credentialData = await getCredentialData(nodeData.credential ?? '', options || {})
            const openRouterApiKey = getCredentialParam('openRouterApiKey', credentialData, nodeData)

            if (!openRouterApiKey) {
                console.warn('OpenRouter API key is missing, using fallback models')
                return getFallbackModels()
            }

            try {
                const response = await axios.get('https://openrouter.ai/api/v1/models', {
                    headers: {
                        'Authorization': `Bearer ${openRouterApiKey}`,
                        'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'http://localhost:3000',
                        'X-Title': 'Flowise'
                    }
                })

                if (response.data && response.data.data) {
                    return response.data.data.map((model: any) => ({
                        label: model.name,
                        name: model.id
                    }))
                } else {
                    console.warn('Unexpected response format from OpenRouter API, using fallback models')
                    return getFallbackModels()
                }
            } catch (error) {
                console.error('Error fetching models from OpenRouter:', error)
                console.warn('Using fallback models')
                return getFallbackModels()
            }
        }
    }

    async init(nodeData: INodeData, _: string, options: ICommonObject): Promise<any> {
        console.log('Initializing ChatOpenRouter_ChatModels');
        console.log('Node data:', safeStringify(nodeData));
        console.log('Options:', safeStringify(options));

        const temperature = nodeData.inputs?.temperature as string;
        const modelName = nodeData.inputs?.modelName as string;
        const maxTokens = nodeData.inputs?.maxTokens as string;
        const streaming = nodeData.inputs?.streaming as boolean;
        const topP = nodeData.inputs?.topP as string;
        const cache = nodeData.inputs?.cache as BaseCache;

        console.log('Node inputs:', { temperature, modelName, maxTokens, streaming, topP });

        try {
            const credentialData = await getCredentialData(nodeData.credential ?? '', options);
            console.log('Credential data:', safeStringify(credentialData));

            const openRouterApiKey = getCredentialParam('openRouterApiKey', credentialData, nodeData);

            if (!openRouterApiKey) {
                throw new Error('OpenRouter API key is required');
            }
        
            console.log('OpenRouter API key retrieved successfully');
            const allowImageUploads = nodeData.inputs?.allowImageUploads as boolean;

            const obj: OpenRouterParams & { id: string } = {
                id: nodeData.id!,
                modelName,
                openRouterApiKey,
                temperature: temperature ? parseFloat(temperature) : undefined,
                maxTokens: maxTokens ? parseInt(maxTokens, 10) : undefined,
                topP: topP ? parseFloat(topP) : undefined,
                streaming,
                cache,
                tools: [] // This will be populated by the Tool Agent later
            };
        
    
            console.log('Creating ChatOpenRouter instance with params:', JSON.stringify(obj, null, 2));
            const model = new ChatOpenRouter(obj);
            console.log('ChatOpenRouter instance created successfully');
    
            const multiModalOption: IMultiModalOption = {
                image: {
                    allowImageUploads: allowImageUploads ?? false
                }
            };
            model.setMultiModalOption(multiModalOption);
    

            if (cache) obj.cache = cache
            if (maxTokens) obj.maxTokens = parseInt(maxTokens, 10)
            if (topP) obj.topP = parseFloat(topP)
            
            return model;
        } catch (error) {
            console.error('Error in ChatOpenRouter_ChatModels init:', error);
            throw error;
        }
    }
}
module.exports = { nodeClass: ChatOpenRouter_ChatModels }