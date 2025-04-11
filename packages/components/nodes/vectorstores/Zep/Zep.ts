import { flatten } from 'lodash'
import { Embeddings } from '@langchain/core/embeddings'
import { Document } from '@langchain/core/documents'
import { ICommonObject, INode, INodeData, INodeOutputsValue, INodeParams, IndexingResult } from '../../../src/Interface'
import { getBaseClasses, getCredentialData, getCredentialParam } from '../../../src/utils'
import { addMMRInputParams, resolveVectorStoreOrRetriever } from '../VectorStoreUtils'

// Create a base class that matches the VectorStore interface
class VectorStore {
    FilterType: any;
    lc_namespace: string[] = ['langchain', 'vectorstores', 'base'];
    _vectorstoreType(): string { return 'custom_vectorstore'; }
    
    // Additional required properties
    lc_serializable = true;
    lc_kwargs: any = {};
    lc_id = ['vectorstore'];
    lc_secrets: any = {};
    
    constructor() {}

    async addVectors(vectors: number[][], documents: Document[]): Promise<void> {
        throw new Error('Method not implemented');
    }

    async addDocuments(documents: Document[]): Promise<void> {
        throw new Error('Method not implemented');
    }

    async similaritySearch(query: string, k?: number, filter?: any): Promise<Document[]> {
        throw new Error('Method not implemented');
    }

    async similaritySearchWithScore(query: string, k?: number, filter?: any): Promise<[Document, number][]> {
        throw new Error('Method not implemented');
    }

    async delete(ids: string[]): Promise<void> {
        throw new Error('Method not implemented');
    }

    static fromTexts(texts: string[], metadatas: object[], embeddings: Embeddings, dbConfig: any): Promise<VectorStore> {
        throw new Error('Method not implemented');
    }

    static fromDocuments(docs: Document[], embeddings: Embeddings, dbConfig: any): Promise<VectorStore> {
        throw new Error('Method not implemented');
    }
}

// Now extend this base class to create ZepVectorStore
class ZepVectorStore extends VectorStore {
    embeddings: Embeddings;
    config: any;
    filter?: Record<string, any>;
    
    constructor(embeddings: Embeddings, config: any) {
        super();
        this.embeddings = embeddings;
        this.config = config;
    }

    _vectorstoreType(): string {
        return 'zep';
    }

    static async fromDocuments(docs: Document[], embeddings: Embeddings, config: any): Promise<ZepVectorStore> {
        const store = new ZepVectorStore(embeddings, config);
        await store.addDocuments(docs);
        return store;
    }

    async addDocuments(documents: Document[]): Promise<void> {
        if (!documents || documents.length === 0) return;
        
        const formattedDocs = await this.formatDocumentsForUpload(documents);
        await this.upsertDocuments(formattedDocs);
    }

    async addVectors(vectors: number[][], documents: Document[]): Promise<void> {
        if (!vectors || !documents || vectors.length === 0 || documents.length === 0) return;
        if (vectors.length !== documents.length) {
            throw new Error("Vectors and documents must have the same length");
        }
        
        const formattedDocs = [];
        for (let i = 0; i < documents.length; i++) {
            formattedDocs.push({
                document_id: `doc_${Date.now()}_${i}`,
                content: documents[i].pageContent,
                embedding: vectors[i],
                metadata: documents[i].metadata || {}
            });
        }
        
        await this.upsertDocuments(formattedDocs);
    }

    async delete(ids: string[]): Promise<void> {
        if (!ids || ids.length === 0) return;
        
        const baseURL = this.config.apiUrl;
        const collectionName = this.config.collectionName;
        const apiKey = this.config.apiKey;
        
        try {
            const headers: Record<string, string> = {
                'Content-Type': 'application/json'
            };
            
            if (apiKey) {
                headers['Authorization'] = `Bearer ${apiKey}`;
            }
            
            // Delete each document by ID
            for (const docId of ids) {
                await fetch(`${baseURL}/api/v1/collection/${collectionName}/document/${docId}`, {
                    method: 'DELETE',
                    headers
                });
            }
        } catch (error) {
            console.error(`Error deleting documents:`, error);
            throw error;
        }
    }

    private async formatDocumentsForUpload(documents: Document[]): Promise<any[]> {
        const formattedDocs = [];
        
        for (let i = 0; i < documents.length; i++) {
            const doc = documents[i];
            const embedding = await this.embeddings.embedQuery(doc.pageContent);
            
            formattedDocs.push({
                document_id: `doc_${Date.now()}_${i}`,
                content: doc.pageContent,
                embedding: embedding,
                metadata: doc.metadata || {}
            });
        }
        
        return formattedDocs;
    }

    private async upsertDocuments(documents: any[]): Promise<void> {
        const baseURL = this.config.apiUrl;
        const collectionName = this.config.collectionName;
        const apiKey = this.config.apiKey;
        
        try {
            // Ensure collection exists
            await this.ensureCollection();
            
            // Split into batches of 100
            const batchSize = 100;
            
            for (let i = 0; i < documents.length; i += batchSize) {
                const batch = documents.slice(i, i + batchSize);
                
                const headers: Record<string, string> = {
                    'Content-Type': 'application/json'
                };
                
                if (apiKey) {
                    headers['Authorization'] = `Bearer ${apiKey}`;
                }
                
                const response = await fetch(`${baseURL}/api/v1/collection/${collectionName}/document`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(batch)
                });
                
                if (!response.ok) {
                    throw new Error(`Failed to upsert documents: ${response.status}`);
                }
            }
        } catch (error) {
            console.error(`Error upserting documents:`, error);
            throw error;
        }
    }

    // Changed from private to protected
    protected async ensureCollection(): Promise<void> {
        const baseURL = this.config.apiUrl;
        const collectionName = this.config.collectionName;
        const apiKey = this.config.apiKey;
        const dimension = this.config.embeddingDimensions || 1536;
        
        try {
            // Check if collection exists
            const headers: Record<string, string> = {
                'Content-Type': 'application/json'
            };
            
            if (apiKey) {
                headers['Authorization'] = `Bearer ${apiKey}`;
            }
            
            const checkResponse = await fetch(`${baseURL}/api/v1/collection/${collectionName}`, {
                headers
            });
            
            if (checkResponse.ok) {
                return;
            }
            
            // Create collection
            const createResponse = await fetch(`${baseURL}/api/v1/collection`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    name: collectionName,
                    description: `Created by Flowise on ${new Date().toISOString()}`,
                    embeddingDimensions: dimension,
                    isAutoEmbedded: false
                })
            });
            
            if (!createResponse.ok) {
                throw new Error(`Failed to create collection: ${createResponse.status}`);
            }
        } catch (error) {
            throw error;
        }
    }

    async similaritySearch(query: string, k?: number, filter?: any): Promise<Document[]> {
        const results = await this.similaritySearchWithScore(
            query,
            k || 4,
            filter || this.filter
        );
        
        return results.map(([doc]) => doc);
    }

    async similaritySearchWithScore(query: string, k?: number, filter?: any): Promise<[Document, number][]> {
        return this.similaritySearchVectorWithScore(
            await this.embeddings.embedQuery(query),
            k || 4,
            filter || this.filter
        );
    }

    async similaritySearchVectorWithScore(
        query: number[],
        k: number,
        filter?: Record<string, any>
    ): Promise<[Document, number][]> {
        const baseURL = this.config.apiUrl;
        const collectionName = this.config.collectionName;
        const apiKey = this.config.apiKey;
        
        try {
            // Ensure collection exists
            await this.ensureCollection();
            
            const headers: Record<string, string> = {
                'Content-Type': 'application/json'
            };
            
            if (apiKey) {
                headers['Authorization'] = `Bearer ${apiKey}`;
            }
            
            const searchData: any = {
                embedding: query,
                limit: k
            };
            
            const actualFilter = filter || this.filter;
            if (actualFilter) {
                searchData.metadata = actualFilter;
            }
            
            const response = await fetch(`${baseURL}/api/v1/collection/${collectionName}/search`, {
                method: 'POST',
                headers,
                body: JSON.stringify(searchData)
            });
            
            if (!response.ok) {
                throw new Error(`Search failed: ${response.status}`);
            }
            
            const results = await response.json();
            
            return results.map((result: any) => [
                new Document({
                    pageContent: result.content || '',
                    metadata: result.metadata || {}
                }),
                result.score || 0
            ]);
        } catch (error) {
            console.error(`Error in similarity search:`, error);
            throw error;
        }
    }

    asRetriever(k?: number): ZepRetriever {
        return new ZepRetriever(this, k);
    }
}

class ZepRetriever {
    vectorStore: ZepVectorStore;
    k: number;
    
    constructor(vectorStore: ZepVectorStore, k: number = 4) {
        this.vectorStore = vectorStore;
        this.k = k;
    }
    
    async getRelevantDocuments(query: string): Promise<Document[]> {
        return this.vectorStore.similaritySearch(query, this.k);
    }
}

class ZepExistingVS extends ZepVectorStore {
    static async fromExistingIndex(embeddings: Embeddings, dbConfig: any): Promise<ZepVectorStore> {
        const instance = new this(embeddings, dbConfig);
        await instance.ensureCollection();
        return instance;
    }
}

class Zep_VectorStores implements INode {
    label: string
    name: string
    version: number
    description: string
    type: string
    icon: string
    category: string
    badge: string
    baseClasses: string[]
    inputs: INodeParams[]
    credential: INodeParams
    outputs: INodeOutputsValue[]

    constructor() {
        this.label = 'Zep Collection - Open Source'
        this.name = 'zep'
        this.version = 2.0
        this.type = 'Zep'
        this.icon = 'zep.svg'
        this.category = 'Vector Stores'
        this.description =
            'Upsert embedded data and perform similarity or mmr search upon query using Zep, a fast and scalable building block for LLM apps'
        this.baseClasses = [this.type, 'VectorStoreRetriever', 'BaseRetriever']
        this.credential = {
            label: 'Connect Credential',
            name: 'credential',
            type: 'credential',
            optional: true,
            description: 'Configure JWT authentication on your Zep instance (Optional)',
            credentialNames: ['zepMemoryApi']
        }
        this.inputs = [
            {
                label: 'Document',
                name: 'document',
                type: 'Document',
                list: true,
                optional: true
            },
            {
                label: 'Embeddings',
                name: 'embeddings',
                type: 'Embeddings'
            },
            {
                label: 'Base URL',
                name: 'baseURL',
                type: 'string',
                default: 'http://127.0.0.1:8000'
            },
            {
                label: 'Zep Collection',
                name: 'zepCollection',
                type: 'string',
                placeholder: 'my-first-collection'
            },
            {
                label: 'Zep Metadata Filter',
                name: 'zepMetadataFilter',
                type: 'json',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Embedding Dimension',
                name: 'dimension',
                type: 'number',
                default: 1536,
                additionalParams: true
            },
            {
                label: 'Top K',
                name: 'topK',
                description: 'Number of top results to fetch. Default to 4',
                placeholder: '4',
                type: 'number',
                additionalParams: true,
                optional: true
            }
        ]
        addMMRInputParams(this.inputs)
        this.outputs = [
            {
                label: 'Zep Retriever',
                name: 'retriever',
                baseClasses: this.baseClasses
            },
            {
                label: 'Zep Vector Store',
                name: 'vectorStore',
                baseClasses: [this.type, ...getBaseClasses(ZepVectorStore)]
            }
        ]
    }

    // Fixed vectorStoreMethods to make options optional
    vectorStoreMethods = {
        upsert: async (nodeData: INodeData, options?: ICommonObject): Promise<void | IndexingResult> => {
            const baseURL = nodeData.inputs?.baseURL as string
            const zepCollection = nodeData.inputs?.zepCollection as string
            const dimension = (nodeData.inputs?.dimension as number) ?? 1536
            const docs = nodeData.inputs?.document as Document[]
            const embeddings = nodeData.inputs?.embeddings as Embeddings

            const credentialData = await getCredentialData(nodeData.credential ?? '', options || {})
            const apiKey = getCredentialParam('apiKey', credentialData, nodeData)

            const flattenDocs = docs && docs.length ? flatten(docs) : []
            const finalDocs = []
            for (let i = 0; i < flattenDocs.length; i += 1) {
                if (flattenDocs[i] && flattenDocs[i].pageContent) {
                    finalDocs.push(new Document(flattenDocs[i]))
                }
            }

            const zepConfig = {
                apiUrl: baseURL,
                collectionName: zepCollection,
                embeddingDimensions: dimension,
                isAutoEmbedded: false,
                apiKey: apiKey
            }

            try {
                await ZepVectorStore.fromDocuments(finalDocs, embeddings, zepConfig)
                return { 
                    numAdded: finalDocs.length, 
                    addedDocs: finalDocs,
                    numDeleted: 0,
                    numUpdated: 0,
                    numSkipped: 0,
                    totalKeys: finalDocs.length
                }
            } catch (e) {
                throw new Error(e)
            }
        },
        
        search: async (nodeData: INodeData, options?: ICommonObject): Promise<Document[]> => {
            // Implement search method
            const baseURL = nodeData.inputs?.baseURL as string
            const zepCollection = nodeData.inputs?.zepCollection as string
            const dimension = (nodeData.inputs?.dimension as number) ?? 1536
            const embeddings = nodeData.inputs?.embeddings as Embeddings
            const query = nodeData.inputs?.query as string
            const topK = nodeData.inputs?.topK as number || 4

            const credentialData = await getCredentialData(nodeData.credential ?? '', options || {})
            const apiKey = getCredentialParam('apiKey', credentialData, nodeData)

            const zepConfig = {
                apiUrl: baseURL,
                collectionName: zepCollection,
                embeddingDimensions: dimension,
                isAutoEmbedded: false,
                apiKey: apiKey
            }

            try {
                const vectorStore = await ZepExistingVS.fromExistingIndex(embeddings, zepConfig)
                return await vectorStore.similaritySearch(query, topK)
            } catch (e) {
                throw new Error(e)
            }
        },
        
        delete: async (nodeData: INodeData, ids: string[], options?: ICommonObject): Promise<void> => {
            // Implement delete method
            const baseURL = nodeData.inputs?.baseURL as string
            const zepCollection = nodeData.inputs?.zepCollection as string
            const dimension = (nodeData.inputs?.dimension as number) ?? 1536
            const embeddings = nodeData.inputs?.embeddings as Embeddings

            const credentialData = await getCredentialData(nodeData.credential ?? '', options || {})
            const apiKey = getCredentialParam('apiKey', credentialData, nodeData)

            const zepConfig = {
                apiUrl: baseURL,
                collectionName: zepCollection,
                embeddingDimensions: dimension,
                isAutoEmbedded: false,
                apiKey: apiKey
            }

            try {
                const vectorStore = await ZepExistingVS.fromExistingIndex(embeddings, zepConfig)
                await vectorStore.delete(ids)
            } catch (e) {
                throw new Error(e)
            }
        }
    }

    async init(nodeData: INodeData, _: string, options: ICommonObject): Promise<any> {
        const baseURL = nodeData.inputs?.baseURL as string
        const zepCollection = nodeData.inputs?.zepCollection as string
        const zepMetadataFilter = nodeData.inputs?.zepMetadataFilter
        const dimension = nodeData.inputs?.dimension as number
        const embeddings = nodeData.inputs?.embeddings as Embeddings
        const topK = nodeData.inputs?.topK as number

        const credentialData = await getCredentialData(nodeData.credential ?? '', options)
        const apiKey = getCredentialParam('apiKey', credentialData, nodeData)

        const zepConfig: any = {
            apiUrl: baseURL,
            collectionName: zepCollection,
            embeddingDimensions: dimension,
            isAutoEmbedded: false,
            apiKey: apiKey
        }
        
        let filter;
        if (zepMetadataFilter) {
            filter = typeof zepMetadataFilter === 'object' ? zepMetadataFilter : JSON.parse(zepMetadataFilter)
        }

        const vectorStore = await ZepExistingVS.fromExistingIndex(embeddings, zepConfig)
        if (filter) {
            vectorStore.filter = filter;
        }

        return resolveVectorStoreOrRetriever(nodeData, vectorStore as any, filter)
    }
}

module.exports = { nodeClass: Zep_VectorStores }