import { Markup } from 'telegraf';
import { InlineKeyboardMarkup } from 'telegraf/typings/core/types/typegram';
import { Context } from 'telegraf';

interface BotInfo {
    id: number;
    firstName: string;
    username: string;
}

export class BotSelector {
    constructor(private bots: BotInfo[]) {}

    getSelectionKeyboard(): Markup.Markup<InlineKeyboardMarkup> {
        return Markup.inlineKeyboard(
            this.bots.map(bot => [
                Markup.button.callback(bot.firstName, `select_bot:${bot.id}`)
            ])
        );
    }

    async showSelector(ctx: Context): Promise<void> {
        await ctx.reply('Select a bot:', this.getSelectionKeyboard());
    }
}