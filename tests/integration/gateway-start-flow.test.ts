import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
    connectMock: vi.fn(),
    waitForStopMock: vi.fn(),
    stopMock: vi.fn(),
    isConnectedMock: vi.fn(),
    cleanupOrphanedTempFilesMock: vi.fn(),
    resolvePluginDebugLogMock: vi.fn(),
    closePluginDebugLogMock: vi.fn(),
    connectionConfig: undefined as any,
    clientGetEndpointMock: vi.fn(),
    clientConnectMock: vi.fn(),
    clientDisconnectMock: vi.fn(),
    listSessionEntriesMock: vi.fn(),
    dwClientConfig: undefined as any,
    storePath: undefined as string | undefined,
}));

vi.mock('openclaw/plugin-sdk/core', () => ({
    buildChannelConfigSchema: vi.fn((schema: unknown) => schema),
}));

vi.mock('dingtalk-stream', () => ({
    TOPIC_CARD: 'TOPIC_CARD',
    TOPIC_ROBOT: 'TOPIC_ROBOT',
    DWClient: class {
        config: Record<string, unknown>;
        getEndpoint: () => Promise<void>;
        _connect: () => Promise<void>;
        connect: () => Promise<void>;
        disconnect: () => void;
        registerCallbackListener: (topic: string, cb: (res: unknown) => Promise<void>) => void;
        socketCallBackResponse: (messageId: string, payload: unknown) => void;

        constructor(config: Record<string, unknown>) {
            this.config = config;
            shared.dwClientConfig = this.config;
            this.getEndpoint = async () => {
                this.config.endpoint = { endpoint: 'wss://wss-open-connection.dingtalk.com:443/connect' };
                await shared.clientGetEndpointMock();
            };
            this._connect = shared.clientConnectMock;
            this.connect = async () => {
                await this.getEndpoint();
                await this._connect();
            };
            this.disconnect = shared.clientDisconnectMock;
            this.registerCallbackListener = vi.fn();
            this.socketCallBackResponse = vi.fn();
        }
    },
}));

vi.mock('../../src/connection-manager', () => ({
    ConnectionManager: class {
        connect: () => Promise<void>;
        waitForStop: () => Promise<void>;
        stop: () => void;
        isConnected: () => boolean;

        constructor(_client: unknown, _accountId: string, config: unknown) {
            shared.connectionConfig = config;
            this.connect = shared.connectMock;
            this.waitForStop = shared.waitForStopMock;
            this.stop = shared.stopMock;
            this.isConnected = shared.isConnectedMock;
        }
    },
}));

vi.mock('../../src/utils', async () => {
    const actual = await vi.importActual<typeof import('../../src/utils')>('../../src/utils');
    return {
        ...actual,
        cleanupOrphanedTempFiles: shared.cleanupOrphanedTempFilesMock,
        resolvePluginDebugLog: shared.resolvePluginDebugLogMock,
        closePluginDebugLog: shared.closePluginDebugLogMock,
    };
});

import { dingtalkPlugin } from '../../src/channel';
import { clearPeerIdRegistry, resolveOriginalPeerId } from '../../src/peer-id-registry';
import { setDingTalkRuntime } from '../../src/runtime';
import {
    clearTargetDirectoryStateCache,
    upsertObservedGroupTarget,
    upsertObservedUserTarget,
} from '../../src/targeting/target-directory-store';

const startGatewayAccount = (ctx: any): Promise<any> => dingtalkPlugin.gateway!.startAccount!(ctx as any);

function createStartContext(abortSignal?: AbortSignal) {
    let status = {
        accountId: 'main',
        running: false,
        lastStartAt: null as number | null,
        lastStopAt: null as number | null,
        lastError: null as string | null,
    };

    const setStatusCalls: Array<typeof status> = [];

    return {
        ctx: {
            cfg: {},
            account: {
                accountId: 'main',
                config: { clientId: 'ding_id', clientSecret: 'ding_secret' },
            },
            abortSignal,
            log: {
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
                debug: vi.fn(),
            },
            getStatus: () => status,
            setStatus: (next: typeof status) => {
                status = next;
                setStatusCalls.push(next);
            },
        },
        setStatusCalls,
    };
}

describe('gateway.startAccount lifecycle', () => {
    beforeEach(() => {
        shared.connectMock.mockReset();
        shared.waitForStopMock.mockReset();
        shared.stopMock.mockReset();
        shared.isConnectedMock.mockReset();
        shared.cleanupOrphanedTempFilesMock.mockReset();
        shared.resolvePluginDebugLogMock.mockReset();
        shared.closePluginDebugLogMock.mockReset();
        shared.connectionConfig = undefined;
        shared.clientGetEndpointMock.mockReset();
        shared.clientConnectMock.mockReset();
        shared.clientDisconnectMock.mockReset();
        shared.listSessionEntriesMock.mockReset();
        shared.dwClientConfig = undefined;
        shared.storePath = undefined;

        shared.connectMock.mockResolvedValue(undefined);
        shared.waitForStopMock.mockResolvedValue(undefined);
        shared.isConnectedMock.mockReturnValue(true);
        shared.clientGetEndpointMock.mockResolvedValue(undefined);
        shared.clientConnectMock.mockResolvedValue(undefined);
        shared.listSessionEntriesMock.mockReturnValue([]);
        shared.resolvePluginDebugLogMock.mockImplementation(({ baseLog }: any) => baseLog);
        setDingTalkRuntime({
            config: { current: () => ({}) },
            agent: {
                session: {
                    listSessionEntries: shared.listSessionEntriesMock,
                },
            },
            channel: {
                session: {
                    resolveStorePath: () => shared.storePath,
                },
            },
        } as any);
        clearPeerIdRegistry();
        clearTargetDirectoryStateCache();
    });

    afterEach(() => {
        if (shared.storePath) {
            rmSync(shared.storePath, { recursive: true, force: true });
        }
    });

    it('fails fast when abortSignal is already aborted before start', async () => {
        const controller = new AbortController();
        controller.abort();
        const { ctx, setStatusCalls } = createStartContext(controller.signal);

        await expect(startGatewayAccount(ctx as any)).rejects.toThrow('Connection aborted before start');

        expect(shared.connectMock).not.toHaveBeenCalled();
        expect(setStatusCalls.some((s) => s.lastError === 'Connection aborted before start')).toBe(true);
    });

    it('connects, waits for stop, and executes stop callback', async () => {
        const { ctx, setStatusCalls } = createStartContext();

        const stopResult = await startGatewayAccount(ctx as any);

        expect(shared.cleanupOrphanedTempFilesMock).toHaveBeenCalledTimes(1);
        expect(shared.resolvePluginDebugLogMock).toHaveBeenCalledWith(expect.objectContaining({
            accountId: 'main',
            baseLog: ctx.log,
            debug: undefined,
            storePath: undefined,
        }));
        expect(shared.connectMock).toHaveBeenCalledTimes(1);
        expect(shared.waitForStopMock).toHaveBeenCalledTimes(1);
        expect(setStatusCalls.some((s) => s.running === true && s.lastStartAt !== null)).toBe(true);

        stopResult.stop();

        expect(shared.closePluginDebugLogMock).toHaveBeenCalledWith(expect.objectContaining({
            accountId: 'main',
        }));
        expect(shared.stopMock).toHaveBeenCalledTimes(1);
        expect(setStatusCalls.some((s) => s.running === false && s.lastStopAt !== null)).toBe(true);
    });

    it('restores case-sensitive peer IDs from the persisted target directory', async () => {
        shared.storePath = mkdtempSync(join(tmpdir(), 'dingtalk-peer-registry-'));
        upsertObservedGroupTarget({
            storePath: shared.storePath,
            accountId: 'main',
            conversationId: 'CidGroup+AbC',
        });
        upsertObservedUserTarget({
            storePath: shared.storePath,
            accountId: 'main',
            senderId: 'UnionUser+XyZ',
            staffId: 'StaffUser+XyZ',
        });
        clearPeerIdRegistry();
        clearTargetDirectoryStateCache();

        await startGatewayAccount(createStartContext().ctx);

        expect(resolveOriginalPeerId('cidgroup+abc')).toBe('CidGroup+AbC');
        expect(resolveOriginalPeerId('unionuser+xyz')).toBe('UnionUser+XyZ');
        expect(resolveOriginalPeerId('staffuser+xyz')).toBe('StaffUser+XyZ');
    });

    it('migrates historical sessions from configured agents into the target directory', async () => {
        shared.storePath = mkdtempSync(join(tmpdir(), 'dingtalk-peer-registry-'));
        shared.listSessionEntriesMock.mockImplementation(({ agentId }: { agentId: string }) =>
            agentId === 'agent-alpha'
                ? [
                    {
                        sessionKey: 'agent:agent-alpha:dingtalk:group:cidlegacy+abc',
                        entry: {
                            sessionId: 'legacy-session',
                            updatedAt: 1000,
                            lastChannel: 'dingtalk',
                            lastAccountId: 'main',
                            lastTo: 'cidLegacy+AbC',
                        },
                    },
                ]
                : [],
        );
        const { ctx } = createStartContext();
        ctx.cfg = {
            agents: {
                list: [
                    { id: 'main', default: true },
                    { id: 'agent-alpha' },
                ],
            },
        } as any;

        await startGatewayAccount(ctx);

        expect(shared.listSessionEntriesMock).toHaveBeenCalledWith({
            agentId: 'agent-alpha',
            storePath: shared.storePath,
            readConsistency: 'latest',
        });
        expect(resolveOriginalPeerId('cidlegacy+abc')).toBe('cidLegacy+AbC');

        clearPeerIdRegistry();
        clearTargetDirectoryStateCache();
        shared.listSessionEntriesMock.mockReturnValue([]);
        await startGatewayAccount(ctx);

        expect(resolveOriginalPeerId('cidlegacy+abc')).toBe('cidLegacy+AbC');
    });

    it('skips historical sessions without an account ID', async () => {
        shared.storePath = mkdtempSync(join(tmpdir(), 'dingtalk-peer-registry-'));
        shared.listSessionEntriesMock.mockReturnValue([
            {
                sessionKey: 'agent:main:dingtalk:group:cidunscoped+abc',
                entry: {
                    sessionId: 'unscoped-session',
                    updatedAt: 1000,
                    lastChannel: 'dingtalk',
                    lastTo: 'cidUnscoped+AbC',
                },
            },
        ]);

        await startGatewayAccount(createStartContext().ctx);

        expect(resolveOriginalPeerId('cidunscoped+abc')).toBe('cidunscoped+abc');
    });

    it('handles abort signal by stopping connection manager and setting stopped status', async () => {
        const controller = new AbortController();
        const { ctx, setStatusCalls } = createStartContext(controller.signal);

        shared.connectMock.mockImplementation(async () => {
            controller.abort();
        });
        shared.isConnectedMock.mockReturnValue(false);

        const result = await startGatewayAccount(ctx as any);

        expect(shared.stopMock).toHaveBeenCalledTimes(1);
        expect(setStatusCalls.some((s) => s.running === false && s.lastStopAt !== null)).toBe(true);

        result.stop();
        expect(shared.stopMock).toHaveBeenCalledTimes(1);
    });

    it('passes maxReconnectCycles from account config to connection manager', async () => {
        const { ctx } = createStartContext();
        ctx.account.config = {
            clientId: 'ding_id',
            clientSecret: 'ding_secret',
            maxReconnectCycles: 7,
        } as any;

        await startGatewayAccount(ctx as any);

        expect(shared.connectionConfig).toMatchObject({
            maxReconnectCycles: 7,
        });
    });

    it('uses DWClient native heartbeat and reconnect when useConnectionManager is false', async () => {
        const controller = new AbortController();
        const { ctx, setStatusCalls } = createStartContext(controller.signal);
        ctx.account.config = {
            clientId: 'ding_id',
            clientSecret: 'ding_secret',
            useConnectionManager: false,
        } as any;
        shared.clientConnectMock.mockImplementation(async () => {
            controller.abort();
        });

        const stopResult = await startGatewayAccount(ctx as any);

        expect(shared.connectMock).not.toHaveBeenCalled();
        expect(shared.connectionConfig).toBeUndefined();
        expect(shared.clientConnectMock).toHaveBeenCalledTimes(1);
        expect(shared.dwClientConfig).toMatchObject({
            keepAlive: true,
            autoReconnect: true,
        });
        expect(setStatusCalls.some((s) => s.running === false && s.lastStopAt !== null)).toBe(true);

        stopResult.stop();
        expect(shared.clientDisconnectMock).toHaveBeenCalledTimes(1);
        expect(shared.stopMock).not.toHaveBeenCalled();
    });

    it('labels websocket-stage failures when native connect fails after open succeeds', async () => {
        const { ctx } = createStartContext();
        ctx.account.config = {
            clientId: 'ding_id',
            clientSecret: 'ding_secret',
            useConnectionManager: false,
        } as any;
        shared.clientConnectMock.mockRejectedValue(new Error('Unexpected server response: 400'));

        await expect(startGatewayAccount(ctx as any)).rejects.toThrow('Unexpected server response: 400');

        expect(shared.clientGetEndpointMock).toHaveBeenCalledTimes(1);
        expect(ctx.log.error).toHaveBeenCalledWith(expect.stringContaining('[DingTalk][ConnectionError][connect.websocket]'));
        expect(ctx.log.error).toHaveBeenCalledWith(expect.stringContaining('wss-open-connection.dingtalk.com'));
    });
});
