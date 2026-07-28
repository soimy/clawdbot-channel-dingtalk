import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/channel-actions", () => ({
    jsonResult: vi.fn((payload: unknown) => payload),
}));

const shared = vi.hoisted(() => ({
    sendMessageMock: vi.fn(),
    sendMediaMock: vi.fn(),
    getLoggerMock: vi.fn(),
    getConfigMock: vi.fn(),
    resolveOriginalPeerIdMock: vi.fn(),
}));

vi.mock("../../src/send-service", () => ({
    sendMessage: shared.sendMessageMock,
    sendMedia: shared.sendMediaMock,
}));

vi.mock("../../src/logger-context", () => ({
    getLogger: shared.getLoggerMock,
}));

vi.mock("../../src/config", () => ({
    getConfig: shared.getConfigMock,
    stripTargetPrefix: (raw: string) => ({ targetId: raw.replace(/^(dingtalk|dd|ding):/i, "") }),
}));

vi.mock("../../src/peer-id-registry", () => ({
    resolveOriginalPeerId: shared.resolveOriginalPeerIdMock,
}));

import { createDingTalkMessageActions } from "../../src/messaging/channel-actions";

describe("createDingTalkMessageActions", () => {
    const cfg = { channels: { dingtalk: { clientId: "id", clientSecret: "sec" } } };
    const cardCfg = {
        channels: { dingtalk: { clientId: "id", clientSecret: "sec", messageType: "card" } },
    };

    beforeEach(() => {
        shared.sendMessageMock.mockReset();
        shared.sendMediaMock.mockReset().mockResolvedValue({
            ok: true,
            messageId: "media_service_1",
            data: { messageId: "media_service_1" },
        });
        shared.getLoggerMock.mockReset().mockReturnValue(undefined);
        shared.getConfigMock.mockReset().mockImplementation((inputCfg: any) => {
            return inputCfg.channels?.dingtalk ?? { clientId: "id", clientSecret: "sec" };
        });
        shared.resolveOriginalPeerIdMock.mockReset().mockImplementation((targetId: string) => targetId);
    });

    it("describes the send action using current SDK capabilities", () => {
        const actions = createDingTalkMessageActions();

        expect(
            actions.describeMessageTool?.({
                cfg: cardCfg as any,
            } as any),
        ).toEqual({
            actions: ["send"],
            capabilities: [],
            schema: null,
        });
    });

    it("exposes send actions for a configured SecretInput reference without resolving it", () => {
        const actions = createDingTalkMessageActions();

        expect(
            actions.describeMessageTool?.({
                cfg: {
                    channels: {
                        dingtalk: {
                            clientId: "id",
                            clientSecret: {
                                source: "env",
                                provider: "env",
                                id: "DINGTALK_MISSING_SECRET",
                            },
                        },
                    },
                },
            } as any),
        ).toEqual({
            actions: ["send"],
            capabilities: [],
            schema: null,
        });
    });

    it("delegates media sends with audioAsVoice derived from action params", async () => {
        const actions = createDingTalkMessageActions();

        await actions.handleAction?.({
            channel: "dingtalk",
            action: "send",
            cfg: cfg as any,
            params: {
                to: "cidA1B2C3",
                media: "/tmp/audio.mp3",
                asVoice: true,
            },
            accountId: "default",
            dryRun: false,
            sessionKey: "dingtalk:direct:cidA1B2C3",
        } as any);

        expect(shared.sendMediaMock).toHaveBeenCalledWith(
            expect.any(Object),
            "cidA1B2C3",
            "/tmp/audio.mp3",
            expect.objectContaining({
                accountId: "default",
                conversationId: "cidA1B2C3",
                audioAsVoice: true,
            }),
        );
    });
});
