import { INodeParams, INodeCredential } from '../src/Interface'

class TelegramApi implements INodeCredential {
    label: string
    name: string
    version: number
    description: string
    inputs: INodeParams[]

    constructor() {
        this.label = 'Telegram API'
        this.name = 'telegramApi'
        this.version = 1.0
        this.description = 'Credentials for accessing the Telegram Bot API. You can obtain a bot token by creating a new bot with @BotFather on Telegram.'
        this.inputs = [
            {
                label: 'Bot Token',
                name: 'botToken',
                type: 'password',
                placeholder: 'Enter your Telegram Bot Token',
                description: 'The token provided by @BotFather when you create a new bot'
            }
        ]
    }
}

module.exports = { credClass: TelegramApi }
