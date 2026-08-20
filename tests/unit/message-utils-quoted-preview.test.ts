import { describe, expect, it } from 'vitest';
import { extractMessageContent } from '../../src/message-utils';
import { buildInboundQuotedRef } from '../../src/messaging/quoted-ref';
import { resolveQuotedRuntimeContext } from '../../src/messaging/quoted-context';

// Payload shapes below mirror real DingTalk Stream callbacks captured during
// device verification (quoted text lives under repliedMsg.content.content and
// interactiveCard text under repliedMsg.content.cardContent element trees).

function buildTextMessage(repliedMsg: Record<string, unknown>): any {
    return {
        msgId: 'current_msg',
        createAt: 1787128600000,
        conversationType: '2',
        conversationId: 'cid_quote',
        senderId: 'sender_a',
        senderStaffId: 'staff_a',
        chatbotUserId: 'bot_user',
        sessionWebhook: 'https://example.com/session',
        msgtype: 'text',
        text: {
            content: '看下这是啥',
            isReplyMsg: true,
            repliedMsg,
        },
    };
}

describe('message-utils quoted preview (real payload shapes)', () => {
    it('text quote: extracts body from content.content', () => {
        const message = buildTextMessage({
            msgType: 'text',
            msgId: 'quoted_text_real',
            createdAt: 1787128548524,
            senderId: 'sender_b',
            content: { content: '被引用的真实文本' },
        });

        const content = extractMessageContent(message);

        expect(content.quoted?.msgId).toBe('quoted_text_real');
        expect(content.quoted?.previewText).toBe('被引用的真实文本');
        expect(content.quoted?.previewMessageType).toBe('text');
    });

    it('text quote: keeps legacy content.text shape working', () => {
        const message = buildTextMessage({
            msgType: 'text',
            msgId: 'quoted_text_legacy',
            createdAt: 1787128548524,
            senderId: 'sender_b',
            content: { text: '旧形态引用文本' },
        });

        const content = extractMessageContent(message);

        expect(content.quoted?.previewText).toBe('旧形态引用文本');
    });

    it('markdown quote: still extracts body from content.text', () => {
        const message = buildTextMessage({
            msgType: 'markdown',
            msgId: 'quoted_markdown',
            createdAt: 1787128548524,
            senderId: 'sender_b',
            content: { text: '# 引用标题\n引用正文' },
        });

        const content = extractMessageContent(message);

        expect(content.quoted?.previewText).toBe('# 引用标题\n引用正文');
        expect(content.quoted?.previewMessageType).toBe('markdown');
    });

    it('interactiveCard quote from another bot: extracts cardContent TEXT nodes', () => {
        const message = buildTextMessage({
            msgType: 'interactiveCard',
            msgId: 'quoted_card_real',
            createdAt: 1787128374370,
            senderId: 'other_bot',
            content: {
                cardContent: [
                    {
                        elementType: 'LIST',
                        children: [
                            {
                                elementType: 'RICHTEXT',
                                children: [{ elementType: 'TEXT', value: 'Hi! How can I help you today?' }],
                            },
                        ],
                    },
                ],
            },
        });

        const content = extractMessageContent(message);

        expect(content.quoted?.previewText).toBe('Hi! How can I help you today?');
        expect(content.quoted?.isQuotedDocCard).toBe(true);
    });

    it('interactiveCard quote of bot reply: extracts cardContent TEXT nodes', () => {
        const message = buildTextMessage({
            msgType: 'interactiveCard',
            msgId: 'quoted_bot_card',
            createdAt: 1787128374370,
            senderId: 'bot_user',
            content: {
                cardContent: [
                    {
                        elementType: 'RICHTEXT',
                        children: [
                            { elementType: 'TEXT', value: '第一行' },
                            { elementType: 'TEXT', value: '第二行' },
                        ],
                    },
                ],
            },
        });

        const content = extractMessageContent(message);

        expect(content.quoted?.isQuotedCard).toBe(true);
        expect(content.quoted?.previewText).toBe('第一行\n第二行');
    });

    it('interactiveCard quote: keeps content.text fallback when cardContent missing', () => {
        const message = buildTextMessage({
            msgType: 'interactiveCard',
            msgId: 'quoted_card_flat',
            createdAt: 1787128374370,
            senderId: 'other_bot',
            content: { text: '扁平卡片文本' },
        });

        const content = extractMessageContent(message);

        expect(content.quoted?.previewText).toBe('扁平卡片文本');
    });

    it('no-msgType quote: accepts content.content in backward-compat path', () => {
        const message = buildTextMessage({
            msgId: 'quoted_no_type',
            createdAt: 1787128548524,
            senderId: 'sender_b',
            content: { content: '无类型引用文本' },
        });

        const content = extractMessageContent(message);

        expect(content.quoted?.msgId).toBe('quoted_no_type');
        expect(content.quoted?.previewText).toBe('无类型引用文本');
    });

    it('group quote with store miss feeds real text into runtime context', () => {
        const message = buildTextMessage({
            msgType: 'text',
            msgId: 'quoted_unseen',
            createdAt: 1787128548524,
            senderId: 'sender_b',
            content: { content: '群里别人发的消息' },
        });

        const content = extractMessageContent(message);
        const quotedRef = buildInboundQuotedRef(message, content);
        const context = resolveQuotedRuntimeContext({
            accountId: 'main',
            conversationId: 'cid_quote',
            quotedRef,
            firstRecord: null,
            firstPreview: content.quoted?.previewText
                ? {
                      text: content.quoted.previewText,
                      messageType: content.quoted.previewMessageType,
                      senderId: content.quoted.previewSenderId,
                  }
                : undefined,
        });

        expect(context?.replyToBody).toBe('群里别人发的消息');
        expect(context?.replyToIsQuote).toBe(true);
    });
});
