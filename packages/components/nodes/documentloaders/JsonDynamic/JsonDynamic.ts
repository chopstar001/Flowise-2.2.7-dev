import { INode, INodeData, INodeParams } from '../../../src/Interface'
import { TextSplitter } from 'langchain/text_splitter'
import { Document } from 'langchain/document'
import { BaseDocumentLoader } from 'langchain/document_loaders/base'
import { getFileFromStorage } from '../../../src'

class JsonDynamicLoader extends BaseDocumentLoader {
    private fileContent: string | Buffer
    private isBase64: boolean

    constructor(fileContent: string | Buffer, isBase64: boolean = false) {
        super()
        this.fileContent = fileContent
        this.isBase64 = isBase64
    }

    async load(): Promise<Document[]> {
        let jsonContent: any
    
        if (this.isBase64) {
            const buffer = Buffer.from(this.fileContent as string, 'base64')
            jsonContent = JSON.parse(buffer.toString('utf-8'))
        } else if (Buffer.isBuffer(this.fileContent)) {
            jsonContent = JSON.parse(this.fileContent.toString('utf-8'))
        } else {
            jsonContent = JSON.parse(this.fileContent as string)
        }
    
        if (!Array.isArray(jsonContent)) {
            console.error('JSON content is not an array:', jsonContent)
            throw new Error('JSON content must be an array of documents')
        }
    
        console.log(`Processing ${jsonContent.length} items from JSON`)
    
        const documents = jsonContent.map((item: any, index: number) => {
            if (typeof item !== 'object' || item === null) {
                console.error(`Item at index ${index} is not an object:`, item)
                return null
            }
    
            const { pageContent, metadata } = item
            if (typeof pageContent !== 'string' || pageContent.trim() === '') {
                console.error(`Item at index ${index} has invalid or empty pageContent:`, item)
                return null
            }

            // Log the chunk order from the metadata
            console.log(`Document ${index} - chunk_order: ${metadata?.chunk_order}, pageContent: ${pageContent.substring(0, 50)}`)

            // Ensure chunk_order is preserved in metadata
            return new Document({ pageContent, metadata })
        }).filter((doc: Document | null) => doc !== null)
    
        console.log(`Created ${documents.length} valid documents`)
    
        return documents
    }
}    

class Json_DynamicDocumentLoaders implements INode {
    label: string
    name: string
    version: number
    type: string
    icon: string
    category: string
    description: string
    baseClasses: string[]
    inputs: INodeParams[]

    constructor() {
        this.label = 'JSON Dynamic Loader'
        this.name = 'jsonDynamicLoader'
        this.version = 1.0
        this.type = 'Document'
        this.icon = 'json.svg'
        this.category = 'Document Loaders'
        this.description = 'Load data from JSON files with dynamic metadata extraction'
        this.baseClasses = [this.type]
        this.inputs = [
            {
                label: 'JSON File',
                name: 'jsonFile',
                type: 'file',
                fileType: '.json'
            },
            {
                label: 'Text Splitter',
                name: 'textSplitter',
                type: 'TextSplitter',
                optional: true
            }
        ]
    }

    async init(nodeData: INodeData, flowData: any, options: Record<string, any>): Promise<any> {
        const jsonFile = nodeData.inputs?.jsonFile as string
        const textSplitter = nodeData.inputs?.textSplitter as TextSplitter

        let fileContent: string | Buffer
        let isBase64 = false

        if (jsonFile.startsWith('FILE-STORAGE::')) {
            const fileNames = JSON.parse(jsonFile.replace('FILE-STORAGE::', ''))
            if (!Array.isArray(fileNames) || fileNames.length === 0) {
                throw new Error('Invalid file storage format')
            }
            const fileName = fileNames[0]
            fileContent = await getFileFromStorage(fileName, options.chatflowid)
            console.log(`Retrieved file from storage: ${fileName}`)
        } else if (jsonFile.startsWith('data:application/json;base64,')) {
            fileContent = jsonFile.split('base64,')[1]
            isBase64 = true
            console.log('Processing base64 encoded JSON')
        } else {
            throw new Error('Unsupported file format')
        }

        const loader = new JsonDynamicLoader(fileContent, isBase64)

        try {
            let docs = await loader.load()
            console.log(`Loaded ${docs.length} documents from JSON`)

            if (textSplitter) {
                docs = await textSplitter.splitDocuments(docs)
                console.log(`Split documents into ${docs.length} chunks`)
            }

            if (docs.length === 0) {
                console.warn('No valid documents were created from the JSON file')
            }

            return docs
        } catch (error: any) {
            console.error('Error processing JSON file:', error)
            throw new Error(`Error processing JSON file: ${error.message}`)
        }
    }
}

module.exports = { nodeClass: Json_DynamicDocumentLoaders }
