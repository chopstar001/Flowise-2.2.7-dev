// MultiQueryTelegramBot.ts

import { PromptTemplate } from '@langchain/core/prompts';
import { INode, INodeData, INodeParams } from '../../../src/Interface';
import { MultiQueryRetriever } from 'langchain/retrievers/multi_query';
import { VectorStore } from '@langchain/core/vectorstores';
import { BaseRetriever, BaseRetrieverInput } from '@langchain/core/retrievers';
import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { CustomRetriever } from '../../TelegramBots/TelegramBot/CustomRetriever';
import { Document } from '@langchain/core/documents';
import { RunnableConfig } from '@langchain/core/runnables';


const DEFAULT_PROMPT = `You are an AI language model assistant. Your task is
to generate 3 different versions of the given user
question to retrieve relevant documents from a vector database.
By generating multiple perspectives on the user question,
your goal is to help the user overcome some of the limitations
of distance-based similarity search.
Provide these alternative questions separated by newlines between XML tags. For example:
<questions>
Question 1
Question 2
Question 3
</questions>
Original question: {question}`;
interface EnhancedDocument extends Document {
    queryOrigin?: string;
    enhancedScore?: number;
}


type ExtendedMetadata = Record<string, any> & {
    processed?: boolean;
    originalLength?: number;
    processedLength?: number;
};

interface FilterCondition {
    $regex: string;
    $options: string;
}

interface FieldFilter {
    [key: string]: FilterCondition;
}

interface Filter {
    $or: FieldFilter[];
}

class AdaptiveRetriever extends BaseRetriever {
    lc_namespace = ["custom", "adaptive_retriever"];

    private multiQueryRetriever: MultiQueryRetriever;
    private vectorStore: VectorStore;
    private originalRetriever: BaseRetriever;  // Add this line
    public verbose: boolean;
    private k: number;
    private readonly MAX_KEYWORD_WORDS = 4;
    private chatModel: BaseChatModel;
    private summationModel: BaseChatModel;
    private utilityModel: BaseChatModel;



    constructor(
        fields: BaseRetrieverInput & {
            multiQueryRetriever: MultiQueryRetriever;
            vectorStore: VectorStore;
            k?: number;
            verbose?: boolean;
            chatModel: BaseChatModel;
            summationModel: BaseChatModel;
            utilityModel: BaseChatModel;

        }
    ) {
        super(fields);
        this.multiQueryRetriever = fields.multiQueryRetriever;
        this.vectorStore = fields.vectorStore;
        this.k = fields.k ?? 10;
        this.verbose = fields.verbose ?? false;
        this.originalRetriever = this.multiQueryRetriever;  // Set this.originalRetriever
        this.chatModel = fields.chatModel;
        this.summationModel = fields.summationModel;
        this.utilityModel = fields.utilityModel;

    }


    async invoke(input: string, options?: RunnableConfig): Promise<Document[]> {
        const query = input;
        
        if (this.verbose) {
            console.log(`[AdaptiveRetriever] ProcessingID-${Date.now()}: "${query}"`);
        }
    
        try {
            // Check if it's a keyword query but don't process it
            if (this.isKeyword(query)) {
                if (this.verbose) {
                    console.log(`[AdaptiveRetriever] Query is keyword, returning empty array. Query: "${query}"`);
                }
                // Just return empty array, don't do any processing
                return [];
            }
    
            // Only proceed with multi-query if it's not a keyword
            if (this.verbose) {
                console.log(`[AdaptiveRetriever] Not a keyword, proceeding with multi-query for: "${query}"`);
            }
            const multiQueryResults = await this.multiQueryRetriever.invoke(query, options);
            
            if (this.verbose) {
                console.log(`[AdaptiveRetriever] Multi-query complete. Results: ${multiQueryResults.length}`);
            }
    
            return this.combineAndDeduplicateResults(multiQueryResults);
        } catch (error) {
            console.error(`[AdaptiveRetriever] Error:`, error);
            throw error;
        }
    }

    private combineAndDeduplicateResults(results: EnhancedDocument[]): EnhancedDocument[] {
        if (this.verbose) console.log(`[AdaptiveRetriever] Combining and deduplicating ${results.length} documents`);

        const uniqueDocuments = new Map<string, EnhancedDocument>();
        const queryDocumentCount = new Map<string, number>();

        // First pass: identify unique documents and count documents per query
        for (const doc of results) {
            const docId = doc.metadata.document_id;
            const chunkOrder = doc.metadata.chunk_order || 0;
            const uniqueKey = `${docId}-${chunkOrder}`;
            const queryOrigin = doc.queryOrigin || 'unknown';

            queryDocumentCount.set(queryOrigin, (queryDocumentCount.get(queryOrigin) || 0) + 1);

            if (!uniqueDocuments.has(uniqueKey) || (doc.metadata.score || 0) > (uniqueDocuments.get(uniqueKey)?.metadata.score || 0)) {
                uniqueDocuments.set(uniqueKey, doc);
                if (this.verbose) console.log(`[AdaptiveRetriever] Adding/Updating document: ${uniqueKey}`);
            }
        }

        // Second pass: calculate enhanced scores
        for (const doc of uniqueDocuments.values()) {
            const queryOrigin = doc.queryOrigin || 'unknown';
            const queryDiversity = 1 / (queryDocumentCount.get(queryOrigin) || 1);
            doc.enhancedScore = (doc.metadata.score || 0) * (1 + queryDiversity);
        }

        // Sort by document_id, then chunk_order, then enhanced score
        const dedupedResults = Array.from(uniqueDocuments.values())
            .sort((a, b) => {
                if (a.metadata.document_id !== b.metadata.document_id) {
                    return a.metadata.document_id.localeCompare(b.metadata.document_id);
                }
                if ((a.metadata.chunk_order || 0) !== (b.metadata.chunk_order || 0)) {
                    return (a.metadata.chunk_order || 0) - (b.metadata.chunk_order || 0);
                }
                return (b.enhancedScore || 0) - (a.enhancedScore || 0);
            });

        if (this.verbose) {
            console.log(`[AdaptiveRetriever] Deduplication complete. ${dedupedResults.length} unique document chunks remain`);
            dedupedResults.forEach((doc, index) => {
                console.log(`[AdaptiveRetriever] Unique document chunk ${index + 1}:`);
                console.log(`  ID: ${doc.metadata.document_id}`);
                console.log(`  Chunk Order: ${doc.metadata.chunk_order || 0}`);
                console.log(`  Query: ${doc.queryOrigin}`);
                console.log(`  Score: ${doc.metadata.score}, Enhanced Score: ${doc.enhancedScore}`);
                console.log(`  Preview: ${doc.pageContent.substring(0, 100)}...`);
            });
        }

        return dedupedResults;
    }

    private isKeyword(query: string): boolean {
        const wordCount = query.trim().split(/\s+/).length;
        if (this.verbose) {
            console.log(`[AdaptiveRetriever] Query "${query}" has ${wordCount} words`);
        }
        return wordCount <= this.MAX_KEYWORD_WORDS;
    }

}


class MultiQueryTelegramBot_Retrievers implements INode {
    label: string;
    name: string;
    version: number;
    description: string;
    type: string;
    icon: string;
    category: string;
    baseClasses: string[];
    inputs: INodeParams[];

    constructor() {
        this.label = 'Multi Query for Telegram Bot with Retrieval Chain';
        this.name = 'MultiQueryTelegramBot';
        this.version = 1.0;
        this.type = 'MultiQueryTelegramBot';
        this.icon = 'MultiQueryTelegramBot.svg';
        this.category = 'Retrievers';
        this.description = 'Generate multiple queries from different perspectives for a given user input query';
        this.baseClasses = [this.type, 'BaseRetriever'];
        this.inputs = [
            {
                label: 'Vector Store',
                name: 'vectorStore',
                type: 'VectorStore'
            },
            {
                label: 'Chat Model',
                name: 'model',
                type: 'BaseChatModel'
            },
            {
                label: 'Prompt',
                name: 'modelPrompt',
                description: 'Prompt for the language model to generate alternative questions and keywords. Use {question} to refer to the original question',
                type: 'string',
                rows: 4,
                default: DEFAULT_PROMPT
            },
            {
                label: 'Top Relevant Docs',
                name: 'topRelevantDocs',
                type: 'number',
                default: 12
            }
        ];
    }

    async init(nodeData: INodeData): Promise<BaseRetriever> {
        const chatModel = nodeData.inputs?.model as BaseChatModel;
        const summationModel = nodeData.inputs?.summationModel as BaseChatModel || chatModel; // Use chatModel as fallback if summationModel is not provided
        const utilityModel = nodeData.inputs?.utilityModel as BaseChatModel || chatModel; // Use chatModel as fallback if summationModel is not provided
        const vectorStore = nodeData.inputs?.vectorStore as VectorStore;
        const promptTemplate = nodeData.inputs?.modelPrompt as string || DEFAULT_PROMPT;
        const topRelevantDocs = nodeData.inputs?.topRelevantDocs as number || 10;
        const verbose = nodeData.inputs?.verbose === true || process.env.DEBUG === 'true';

        const adaptiveRetriever = await this.createAdaptiveRetriever(chatModel, summationModel, utilityModel, vectorStore, promptTemplate, verbose);

        return new CustomRetriever({
            retriever: adaptiveRetriever,
            vectorStore: vectorStore,  // Add this line
            topRelevantDocs: topRelevantDocs,
            postProcessor: this.postProcessQueries.bind(this),
            verbose: verbose,
            chatModel: chatModel,
            summationModel: summationModel,
            utilityModel: utilityModel,

        });
    }

    private async createAdaptiveRetriever(
        chatModel: BaseChatModel,
        summationModel: BaseChatModel,
        utilityModel: BaseChatModel,
        vectorStore: VectorStore,
        promptTemplate: string,
        verbose: boolean
    ): Promise<BaseRetriever> {
        console.log(`[MultiQueryTelegramBot] Creating AdaptiveRetriever`);
        const prompt = PromptTemplate.fromTemplate(promptTemplate);

        const vectorStoreRetriever = vectorStore.asRetriever();

        const multiQueryRetriever = MultiQueryRetriever.fromLLM({
            llm: chatModel, // Use chatModel for generating multiple queries
            retriever: vectorStoreRetriever,
            verbose: verbose,
            prompt: prompt,
        });

        return new AdaptiveRetriever({
            multiQueryRetriever,
            vectorStore: vectorStore,
            k: 10,
            verbose,
            chatModel,
            summationModel,
            utilityModel
        });
    }


    private async postProcessQueries(
        documents: Document[],
        query: string,
        verbose: boolean = false
    ): Promise<Document<ExtendedMetadata>[]> {
        const processedDocs = documents.map(doc => {
            const match = doc.pageContent.match(/<questions>([\s\S]*?)<\/questions>/);
            if (match) {
                const questions = match[1].trim().split('\n').filter(q => q.trim().length > 0);
                const processedQuestions = questions.join('\n');

                return new Document({
                    pageContent: doc.pageContent.replace(/<questions>[\s\S]*?<\/questions>/, `<questions>\n${processedQuestions}\n</questions>`),
                    metadata: { ...doc.metadata, processed: true }
                });
            }
            return doc; // If no questions found, return the original document
        });

        if (verbose) {
            console.log(`[PostProcess] Total documents processed: ${documents.length}, Retained: ${processedDocs.length}`);
            processedDocs.forEach((doc, index) => {
                console.log(`[PostProcess] Document ${index + 1} preview: ${doc.pageContent.substring(0, 100)}...`);
            });
        }

        return processedDocs;
    }
}

module.exports = { nodeClass: MultiQueryTelegramBot_Retrievers };