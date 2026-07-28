import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/core', () => ({
    buildChannelConfigSchema: vi.fn((schema: unknown) => schema),
}));

vi.mock('openclaw/plugin-sdk/channel-actions', () => ({
    jsonResult: vi.fn((payload: unknown) => payload),
}));

vi.mock('openclaw/plugin-sdk/tool-send', () => ({
    extractToolSend: vi.fn((args: Record<string, unknown>) => {
        const target = args.to;
        if (typeof target !== 'string' || !target.trim()) {
            return null;
        }
        return { to: target.trim() };
    }),
}));

const { sendMessageMock, sendMediaMock, sendProactiveMediaMock, getRuntimeMock } = vi.hoisted(() => ({
    sendMessageMock: vi.fn(),
    sendMediaMock: vi.fn(),
    sendProactiveMediaMock: vi.fn(),
    getRuntimeMock: vi.fn(),
}));

const { prepareMediaInputMock } = vi.hoisted(() => ({
    prepareMediaInputMock: vi.fn(),
}));

vi.mock('dingtalk-stream', () => ({
    TOPIC_CARD: 'TOPIC_CARD',
    DWClient: vi.fn(),
    TOPIC_ROBOT: 'TOPIC_ROBOT',
}));

vi.mock('../../src/runtime', () => ({
    getDingTalkRuntime: getRuntimeMock,
}));

vi.mock('../../src/send-service', async () => ({
    sendMessage: sendMessageMock,
    sendMedia: sendMediaMock,
    sendProactiveMedia: sendProactiveMediaMock,
    sendBySession: vi.fn(),
    uploadMedia: vi.fn(),
}));

vi.mock('../../src/media-utils', async () => {
    const actual = await vi.importActual<typeof import('../../src/media-utils')>('../../src/media-utils');
    return {
        ...actual,
        prepareMediaInput: prepareMediaInputMock,
    };
});

import { dingtalkPlugin } from '../../src/channel';

describe('dingtalkPlugin.actions.send', () => {
    const cfg = { channels: { dingtalk: { clientId: 'id', clientSecret: 'sec' } } };
    const cardCfg = {
        channels: { dingtalk: { clientId: 'id', clientSecret: 'sec', messageType: 'card' } },
    };

    beforeEach(() => {
        sendMessageMock.mockReset();
        sendMediaMock.mockReset().mockResolvedValue({
            ok: true,
            messageId: 'media_service_1',
            data: { messageId: 'media_service_1' },
        });
        sendProactiveMediaMock.mockReset();
        getRuntimeMock.mockReset().mockReturnValue({
            channel: {
                session: {
                    resolveStorePath: vi.fn().mockReturnValue('/tmp/store.json'),
                },
            },
        });
        prepareMediaInputMock.mockReset();
        prepareMediaInputMock.mockImplementation(async (input: string) => ({ path: input }));
    });

    it('delegates audio media with asVoice=true to sendMedia as voice', async () => {
        await dingtalkPlugin.actions?.handleAction?.({
            channel: 'dingtalk',
            action: 'send',
            cfg: cfg as any,
            params: {
                to: 'cidA1B2C3',
                media: '/tmp/audio.mp3',
                asVoice: true,
            },
            accountId: 'default',
            dryRun: false,
        } as any);

        expect(sendMediaMock).toHaveBeenCalledWith(
            expect.any(Object),
            'cidA1B2C3',
            '/tmp/audio.mp3',
            expect.objectContaining({
                accountId: 'default',
                audioAsVoice: true,
            })
        );
        expect(sendMessageMock).not.toHaveBeenCalled();
        expect(sendProactiveMediaMock).not.toHaveBeenCalled();
    });

    it('delegates audio media with audioAsVoice=true to sendMedia as voice', async () => {
        await dingtalkPlugin.actions?.handleAction?.({
            channel: 'dingtalk',
            action: 'send',
            cfg: cfg as any,
            params: {
                to: 'cidA1B2C3',
                media: '/tmp/audio.mp3',
                audioAsVoice: true,
            },
            accountId: 'default',
            dryRun: false,
        } as any);

        expect(sendMediaMock).toHaveBeenCalledWith(
            expect.any(Object),
            'cidA1B2C3',
            '/tmp/audio.mp3',
            expect.objectContaining({
                accountId: 'default',
                audioAsVoice: true,
            })
        );
        expect(sendMessageMock).not.toHaveBeenCalled();
        expect(sendProactiveMediaMock).not.toHaveBeenCalled();
    });

    it('describes message tool with the current SDK send capability contract', () => {
        expect(
            dingtalkPlugin.actions?.describeMessageTool?.({
                cfg: cardCfg as any,
            } as any),
        ).toEqual({
            actions: ['send'],
            capabilities: [],
            schema: null,
        });
    });

    it('bubbles sendMedia validation errors for invalid voice inputs', async () => {
        sendMediaMock.mockResolvedValueOnce({
            ok: false,
            error: 'DingTalk send with asVoice requires an audio file.',
        });

        await expect(
            dingtalkPlugin.actions?.handleAction?.({
                channel: 'dingtalk',
                action: 'send',
                cfg: cfg as any,
                params: {
                    to: 'cidA1B2C3',
                    media: '/tmp/not-audio.pdf',
                    asVoice: true,
                },
                accountId: 'default',
                dryRun: false,
            } as any),
        ).rejects.toThrow(/requires an audio file/i);

        expect(sendMediaMock).toHaveBeenCalled();
        expect(sendMessageMock).not.toHaveBeenCalled();
    });

    it('sends text proactively when no media is provided', async () => {
        sendMessageMock.mockResolvedValueOnce({ ok: true, data: { processQueryKey: 'text_1' } });

        await dingtalkPlugin.actions?.handleAction?.({
            channel: 'dingtalk',
            action: 'send',
            cfg: cfg as any,
            params: {
                to: 'user_abc',
                message: 'hello',
            },
            accountId: 'default',
            dryRun: false,
        } as any);

        expect(sendMessageMock).toHaveBeenCalledWith(
            expect.any(Object),
            'user_abc',
            'hello',
            expect.objectContaining({ accountId: 'default' })
        );
        expect(sendMessageMock).toHaveBeenCalledWith(
            expect.any(Object),
            'user_abc',
            'hello',
            expect.not.objectContaining({
                storePath: expect.anything(),
                conversationId: expect.anything(),
            })
        );
        expect(sendMediaMock).not.toHaveBeenCalled();
        expect(sendProactiveMediaMock).not.toHaveBeenCalled();
    });

    it('rejects asVoice without media path', async () => {
        await expect(
            dingtalkPlugin.actions?.handleAction?.({
                channel: 'dingtalk',
                action: 'send',
                cfg: cfg as any,
                params: {
                    to: 'user_abc',
                    message: 'hello',
                    asVoice: true,
                },
                accountId: 'default',
                dryRun: false,
            } as any),
        ).rejects.toThrow(/requires media\/path\/filePath\/mediaUrl/);

        expect(sendMessageMock).not.toHaveBeenCalled();
        expect(sendMediaMock).not.toHaveBeenCalled();
        expect(sendProactiveMediaMock).not.toHaveBeenCalled();
    });

    it('routes card mode media sends through unified sendMedia service', async () => {
        await dingtalkPlugin.actions?.handleAction?.({
            channel: 'dingtalk',
            action: 'send',
            cfg: cardCfg as any,
            params: {
                to: 'cidA1B2C3',
                media: './artifacts/demo.png',
            },
            accountId: 'default',
            dryRun: false,
        } as any);

        expect(sendMediaMock).toHaveBeenCalledWith(
            expect.objectContaining({
                clientId: 'id',
                clientSecret: 'sec',
                messageType: 'card',
            }),
            'cidA1B2C3',
            './artifacts/demo.png',
            expect.objectContaining({
                accountId: 'default',
            })
        );
        expect(sendProactiveMediaMock).not.toHaveBeenCalled();
    });

    it('falls back to direct target for conversationId and expectedCardOwnerId when sessionKey is missing', async () => {
        await dingtalkPlugin.actions?.handleAction?.({
            channel: 'dingtalk',
            action: 'send',
            cfg: cardCfg as any,
            params: {
                to: 'manager8031',
                media: './artifacts/demo.png',
            },
            accountId: 'default',
            dryRun: false,
        } as any);

        expect(sendMediaMock).toHaveBeenCalledWith(
            expect.any(Object),
            'manager8031',
            './artifacts/demo.png',
            expect.objectContaining({
                accountId: 'default',
                conversationId: 'manager8031',
                expectedCardOwnerId: 'manager8031',
            })
        );
    });

    it('falls back to direct target for conversationId when sessionKey is unusable', async () => {
        await dingtalkPlugin.actions?.handleAction?.({
            channel: 'dingtalk',
            action: 'send',
            cfg: cardCfg as any,
            params: {
                to: 'manager8031',
                media: './artifacts/demo.png',
            },
            accountId: 'default',
            sessionKey: '-',
            dryRun: false,
        } as any);

        expect(sendMediaMock).toHaveBeenCalledWith(
            expect.any(Object),
            'manager8031',
            './artifacts/demo.png',
            expect.objectContaining({
                conversationId: 'manager8031',
                expectedCardOwnerId: 'manager8031',
            })
        );
    });

    it('forwards expectedCardOwnerId into unified sendMedia service in card mode', async () => {
        await dingtalkPlugin.actions?.handleAction?.({
            channel: 'dingtalk',
            action: 'send',
            cfg: cardCfg as any,
            params: {
                to: 'cidA1B2C3',
                media: './artifacts/demo.png',
                expectedCardOwnerId: 'manager0831',
            },
            accountId: 'default',
            dryRun: false,
        } as any);

        expect(sendMediaMock).toHaveBeenCalledWith(
            expect.any(Object),
            'cidA1B2C3',
            './artifacts/demo.png',
            expect.objectContaining({
                expectedCardOwnerId: 'manager0831',
            })
        );
        expect(sendProactiveMediaMock).not.toHaveBeenCalled();
    });

    it('passes mediaUrl through to sendMedia without local path resolution in action layer', async () => {
        await dingtalkPlugin.actions?.handleAction?.({
            channel: 'dingtalk',
            action: 'send',
            cfg: cfg as any,
            params: {
                to: 'cidA1B2C3',
                mediaUrl: 'https://example.com/photo.png',
            },
            accountId: 'default',
            dryRun: false,
        } as any);

        expect(sendMediaMock).toHaveBeenCalledWith(
            expect.any(Object),
            'cidA1B2C3',
            'https://example.com/photo.png',
            expect.objectContaining({ accountId: 'default' })
        );
        expect(prepareMediaInputMock).not.toHaveBeenCalled();
        expect(sendProactiveMediaMock).not.toHaveBeenCalled();
    });
    it('forwards current direct conversationId to sendMedia when sessionKey is direct', async () => {
        await dingtalkPlugin.actions?.handleAction?.({
            channel: 'dingtalk',
            action: 'send',
            cfg: cardCfg as any,
            params: {
                to: 'manager8031',
                media: './artifacts/demo.png',
                expectedCardOwnerId: 'manager8031',
            },
            accountId: 'default',
            sessionKey: 'agent:main:dingtalk:direct:manager8031',
            dryRun: false,
        } as any);

        expect(sendMediaMock).toHaveBeenCalledWith(
            expect.any(Object),
            'manager8031',
            './artifacts/demo.png',
            expect.objectContaining({
                conversationId: 'manager8031',
                expectedCardOwnerId: 'manager8031',
            })
        );
    });
});

describe('dingtalkPlugin.outbound.sendMedia', () => {
    const cfg = {
        channels: { dingtalk: { clientId: 'id', clientSecret: 'sec', messageType: 'card' } },
        session: { store: { provider: 'memory' } },
    };

    beforeEach(() => {
        sendMediaMock.mockReset().mockResolvedValue({
            ok: true,
            messageId: 'media_service_outbound_1',
            data: { messageId: 'media_service_outbound_1' },
        });
        getRuntimeMock.mockReset().mockReturnValue({
            channel: {
                session: {
                    resolveStorePath: vi.fn().mockReturnValue('/tmp/store.json'),
                },
            },
        });
    });

    it('delegates outbound media sends to unified sendMedia service with persisted context', async () => {
        const log = { debug: vi.fn(), error: vi.fn() };

        const result = await dingtalkPlugin.outbound!.sendMedia?.({
            cfg: cfg as any,
            to: 'cidA1B2C3',
            mediaPath: './artifacts/demo.png',
            accountId: 'default',
            mediaLocalRoots: ['/sandbox/media'],
            expectedCardOwnerId: 'manager0831',
            log,
        } as any);

        expect(sendMediaMock).toHaveBeenCalledWith(
            expect.objectContaining({
                clientId: 'id',
                clientSecret: 'sec',
                messageType: 'card',
            }),
            'cidA1B2C3',
            './artifacts/demo.png',
            expect.objectContaining({
                accountId: 'default',
                storePath: '/tmp/store.json',
                conversationId: 'cidA1B2C3',
                mediaLocalRoots: ['/sandbox/media'],
                expectedCardOwnerId: 'manager0831',
                log,
            })
        );
        expect(result).toEqual({
            channel: 'dingtalk',
            messageId: 'media_service_outbound_1',
            meta: { data: { messageId: 'media_service_outbound_1' } },
        });
    });
});
