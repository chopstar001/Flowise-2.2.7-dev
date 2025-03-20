import { INodeParams, INodeCredential } from '../src/Interface'

class OpenRouterApi implements INodeCredential {
    label: string
    name: string
    version: number
    inputs: INodeParams[]

    constructor() {
        this.label = 'OpenRouter API'
        this.name = 'openRouterApi'
        this.version = 1.0
        this.inputs = [
            {
                label: 'OpenRouter API Key',
                name: 'openRouterApiKey',
                type: 'password'
            }
        ]
    }
}

module.exports = { credClass: OpenRouterApi }
