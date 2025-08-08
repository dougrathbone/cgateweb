// TypeScript declarations for cgateweb

declare module '@cgateweb/logger' {
    interface LoggerOptions {
        level?: 'error' | 'warn' | 'info' | 'debug' | 'trace';
        component?: string;
        enabled?: boolean;
    }

    export class Logger {
        constructor(options?: LoggerOptions);
        error(message: string, meta?: object): void;
        warn(message: string, meta?: object): void;
        info(message: string, meta?: object): void;
        debug(message: string, meta?: object): void;
        trace(message: string, meta?: object): void;
        time(label: string): void;
        timeEnd(label: string): void;
        child(options?: LoggerOptions): Logger;
        setLevel(level: string): void;
    }

    export function createLogger(options?: LoggerOptions): Logger;
}

declare module '@cgateweb/error-handler' {
    export class ErrorHandler {
        constructor(component: string);
        handle(error: Error, context?: object, action?: string | null, fatal?: boolean): void;
        handleConnectionError(
            error: Error, 
            context?: object, 
            retryCallback?: (() => void) | null, 
            retryCount?: number, 
            maxRetries?: number
        ): boolean;
        handleValidationError(error: Error, data?: object, field?: string | null): void;
        handleParsingError(error: Error, input?: string, expectedFormat?: string | null): void;
        wrapAsync(asyncFn: Function, action: string, context?: object): Function;
        createTimeoutPromise(timeoutMs: number, operation?: string): Promise<never>;
    }

    export function createErrorHandler(component: string): ErrorHandler;
}

declare module '@cgateweb/cbus' {
    export interface CBusEventData {
        network: string;
        application: string;
        group: string;
        action: string;
        sourceunit?: string;
        level?: number;
    }

    export class CBusEvent {
        constructor(eventData: string, logger?: any);
        parse(): CBusEventData | null;
        isValid(): boolean;
        getNetwork(): string;
        getApplication(): string; 
        getGroup(): string;
        getAction(): string;
        getSourceUnit(): string | null;
        getLevel(): number | null;
        toString(): string;
    }

    export interface CBusCommandData {
        network: string;
        application: string;
        group: string;
        type: string;
        payload: string;
        level?: number;
        rampTime?: string;
    }

    export class CBusCommand {
        constructor(topic: string, payload: string, logger?: any);
        parse(): boolean;
        isValid(): boolean;
        getNetwork(): string;
        getApplication(): string;
        getGroup(): string;
        getType(): string;
        getPayload(): string;
        getLevel(): number | null;
        getRampTime(): string | null;
        toCGateCommand(): string;
    }
}

declare module '@cgateweb/connections' {
    import { EventEmitter } from 'events';

    export interface ConnectionSettings {
        cbusip: string;
        cbuscommandport: number;
        cbuseventport: number;
        cgateusername?: string;
        cgatepassword?: string;
        connectionTimeout?: number;
        maxRetries?: number;
        reconnectinitialdelay?: number;
        reconnectmaxdelay?: number;
    }

    export class CgateConnection extends EventEmitter {
        constructor(type: string, host: string, port: number, settings: ConnectionSettings);
        connect(): Promise<void>;
        disconnect(): void;
        send(command: string): boolean;
        isConnected(): boolean;
    }

    export class CgateConnectionPool extends EventEmitter {
        constructor(type: string, host: string, port: number, settings: ConnectionSettings);
        start(): Promise<void>;
        stop(): Promise<void>;
        execute(command: string): Promise<boolean>;
        getStats(): object;
        readonly isStarted: boolean;
        readonly healthyConnections: Set<CgateConnection>;
    }
}

declare module '@cgateweb/mqtt' {
    import { EventEmitter } from 'events';

    export interface MqttSettings {
        mqtt: string;
        mqttusername?: string;
        mqttpassword?: string;
        retainreads?: boolean;
    }

    export class MqttManager extends EventEmitter {
        constructor(settings: MqttSettings);
        connect(): void;
        disconnect(): void;
        publish(topic: string, message: string, options?: object): void;
        subscribe(topic: string, callback?: (error?: Error) => void): void;
        readonly connected: boolean;
    }
}

declare module '@cgateweb/bridge' {
    import { EventEmitter } from 'events';

    export interface BridgeSettings extends ConnectionSettings, MqttSettings {
        messageinterval?: number;
        getallonstart?: boolean;
        getallperiod?: number | null;
        getallnetapp?: string | null;
        ha_discovery_enabled?: boolean;
        ha_discovery_prefix?: string;
        ha_discovery_networks?: string[];
        ha_discovery_cover_app_id?: string;
        ha_discovery_switch_app_id?: string | null;
        ha_discovery_relay_app_id?: string | null;
        ha_discovery_pir_app_id?: string | null;
    }

    export class CgateWebBridge extends EventEmitter {
        constructor(settings: BridgeSettings);
        start(): Promise<CgateWebBridge>;
        stop(): void;
        readonly settings: BridgeSettings;
        readonly mqttManager: import('@cgateweb/mqtt').MqttManager;
        readonly commandConnectionPool: import('@cgateweb/connections').CgateConnectionPool;
        readonly eventConnection: import('@cgateweb/connections').CgateConnection;
    }
}

declare module '@cgateweb/discovery' {
    export interface DiscoverySettings {
        ha_discovery_enabled: boolean;
        ha_discovery_prefix: string;
        ha_discovery_networks: string[];
        ha_discovery_cover_app_id?: string;
        ha_discovery_switch_app_id?: string | null;
        ha_discovery_relay_app_id?: string | null;
        ha_discovery_pir_app_id?: string | null;
    }

    export class HADiscovery {
        constructor(settings: DiscoverySettings, mqttManager: any, logger?: any);
        triggerDiscovery(): void;
        processTreeData(network: string, treeData: string): void;
    }
}

// Main module exports
declare module 'cgateweb' {
    export * from '@cgateweb/logger';
    export * from '@cgateweb/error-handler';
    export * from '@cgateweb/cbus';
    export * from '@cgateweb/connections';
    export * from '@cgateweb/mqtt';
    export * from '@cgateweb/bridge';
    export * from '@cgateweb/discovery';

    export const defaultSettings: import('@cgateweb/bridge').BridgeSettings;
    export function main(): Promise<void>;
}
