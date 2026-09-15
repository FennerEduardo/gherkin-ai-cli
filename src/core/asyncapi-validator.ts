/* ==========================================================================
   gherkin-ai-cli - AsyncAPI Specification Validator
   
   Validates AsyncAPI 2.x documents structurally and cross-references
   against the Semantic IR to ensure contract-spec consistency.
   ========================================================================== */

import fs from 'fs';
import yaml from 'yaml';
import { SpecificationIR } from './semantic-ir';

export interface AsyncAPIValidationResult {
  valid: boolean;
  errors: { path: string; message: string }[];
  warnings: { path: string; message: string }[];
  specVersion: string;
}

/**
 * Validates an AsyncAPI specification file for structural correctness.
 */
export function validateAsyncAPISpec(specPath: string): AsyncAPIValidationResult {
  const result: AsyncAPIValidationResult = {
    valid: false,
    errors: [],
    warnings: [],
    specVersion: ''
  };

  try {
    const content = fs.readFileSync(specPath, 'utf8');
    let doc: any;

    if (specPath.endsWith('.json')) {
      doc = JSON.parse(content);
    } else {
      doc = yaml.parse(content);
    }

    if (!doc) {
      result.errors.push({ path: '$', message: 'Empty or invalid AsyncAPI document' });
      return result;
    }

    // 1. Version field
    result.specVersion = doc.asyncapi || 'unknown';
    if (result.specVersion === 'unknown') {
      result.errors.push({ path: '$', message: 'Missing required "asyncapi" version field' });
    } else if (!result.specVersion.startsWith('2.')) {
      result.warnings.push({ path: '$.asyncapi', message: `AsyncAPI version "${result.specVersion}" detected. This validator is optimized for AsyncAPI 2.x` });
    }

    // 2. Info block
    if (!doc.info || !doc.info.title || !doc.info.version) {
      result.errors.push({ path: '$.info', message: 'Missing required "info.title" or "info.version"' });
    }

    // 3. Channels
    if (!doc.channels || Object.keys(doc.channels).length === 0) {
      result.errors.push({ path: '$.channels', message: 'Missing required "channels" object or no channels defined' });
    } else {
      validateChannels(doc, result);
    }

    // 4. Resolve $ref references
    validateRefs(doc, result);

    result.valid = result.errors.length === 0;
    return result;
  } catch (e: any) {
    result.errors.push({ path: '$', message: `Parse error: ${e.message}` });
    return result;
  }
}

/**
 * Validates an AsyncAPI spec and cross-references it with the Semantic IR.
 */
export function validateAsyncAPIAgainstIR(specPath: string, ir: SpecificationIR): AsyncAPIValidationResult {
  const baseResult = validateAsyncAPISpec(specPath);
  if (!baseResult.valid) {
    return baseResult;
  }

  const content = fs.readFileSync(specPath, 'utf8');
  const doc = specPath.endsWith('.json') ? JSON.parse(content) : yaml.parse(content);

  // 1. Every IR event should have a corresponding AsyncAPI channel
  for (const event of ir.events) {
    const eventName = event.name;
    const matchingChannel = findChannelForEvent(doc.channels, eventName);

    if (!matchingChannel) {
      baseResult.errors.push({
        path: `$.channels`,
        message: `Event "${eventName}" defined in IR has no corresponding AsyncAPI channel`
      });
      continue;
    }

    // 2. Check payload field consistency
    const message = getMessageFromChannel(matchingChannel.value);
    if (message && message.payload && message.payload.properties?.payload?.properties) {
      const asyncFields = Object.keys(message.payload.properties.payload.properties);
      const irFields = ir.fields.map(f => f.name);

      for (const irField of irFields) {
        if (!asyncFields.includes(irField)) {
          baseResult.warnings.push({
            path: `$.channels['${matchingChannel.key}'].message.payload.properties.payload`,
            message: `IR field "${irField}" is not present in AsyncAPI event "${eventName}" payload`
          });
        }
      }
    }
  }

  // 3. Check for orphan channels (channels without matching IR events)
  if (doc.channels) {
    for (const [channelName] of Object.entries(doc.channels)) {
      const hasMatchingEvent = ir.events.some(ev =>
        channelName.toLowerCase().includes(ev.name.toLowerCase())
      );
      if (!hasMatchingEvent) {
        baseResult.warnings.push({
          path: `$.channels['${channelName}']`,
          message: `AsyncAPI channel "${channelName}" has no matching event in IR`
        });
      }
    }
  }

  baseResult.valid = baseResult.errors.length === 0;
  return baseResult;
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

function validateChannels(doc: any, result: AsyncAPIValidationResult): void {
  for (const [channelName, channelDef] of Object.entries(doc.channels as Record<string, any>)) {
    const channelPath = `$.channels['${channelName}']`;

    // Must have publish or subscribe
    if (!channelDef.publish && !channelDef.subscribe) {
      result.errors.push({
        path: channelPath,
        message: `Channel "${channelName}" must have at least a "publish" or "subscribe" operation`
      });
      continue;
    }

    // Validate each operation
    const operations = [
      { key: 'publish', def: channelDef.publish },
      { key: 'subscribe', def: channelDef.subscribe }
    ].filter(op => op.def);

    for (const op of operations) {
      const opPath = `${channelPath}.${op.key}`;

      // Message must have payload
      if (!op.def.message) {
        result.errors.push({ path: opPath, message: `Operation "${op.key}" is missing "message" definition` });
        continue;
      }

      if (!op.def.message.payload) {
        result.errors.push({ path: `${opPath}.message`, message: `Message in "${op.key}" is missing "payload" schema` });
      }

      // Check headers
      if (op.def.message.headers) {
        const headerProps = op.def.message.headers.properties || {};
        if (!headerProps.correlationId) {
          result.warnings.push({
            path: `${opPath}.message.headers`,
            message: `Missing "correlationId" in message headers for channel "${channelName}"`
          });
        }
        if (!headerProps.causationId) {
          result.warnings.push({
            path: `${opPath}.message.headers`,
            message: `Missing "causationId" in message headers for channel "${channelName}"`
          });
        }

        // DLQ consistency: if retryCount exists but no dlqReason
        if (headerProps.retryCount && !headerProps.dlqReason) {
          result.warnings.push({
            path: `${opPath}.message.headers`,
            message: `Header has "retryCount" but no "dlqReason" for channel "${channelName}". Consider adding DLQ metadata.`
          });
        }
      } else {
        result.warnings.push({
          path: `${opPath}.message`,
          message: `No headers defined for message in channel "${channelName}". Consider adding correlationId/causationId.`
        });
      }

      // Validate correlationId location format
      if (op.def.message.correlationId && op.def.message.correlationId.location) {
        const loc = op.def.message.correlationId.location;
        if (!loc.startsWith('$message.')) {
          result.warnings.push({
            path: `${opPath}.message.correlationId.location`,
            message: `correlationId location "${loc}" should follow "$message.header#/..." or "$message.payload#/..." format`
          });
        }
      }
    }

    // Validate broker bindings
    if (channelDef.bindings) {
      validateBindings(channelDef.bindings, channelName, channelPath, result);
    }
  }
}

function validateBindings(bindings: any, channelName: string, channelPath: string, result: AsyncAPIValidationResult): void {
  // RabbitMQ bindings
  if (bindings.rabbitmq) {
    const rmq = bindings.rabbitmq;
    if (rmq.is === 'routingKey' && !rmq.queue) {
      result.warnings.push({
        path: `${channelPath}.bindings.rabbitmq`,
        message: `RabbitMQ binding for "${channelName}" has routingKey type but no queue configuration`
      });
    }
    if (rmq.queue && !rmq.queue.name) {
      result.errors.push({
        path: `${channelPath}.bindings.rabbitmq.queue`,
        message: `RabbitMQ queue must have a "name" defined`
      });
    }
  }

  // Kafka bindings
  if (bindings.kafka) {
    const kafka = bindings.kafka;
    if (!kafka.topic) {
      result.warnings.push({
        path: `${channelPath}.bindings.kafka`,
        message: `Kafka binding for "${channelName}" is missing "topic"`
      });
    }
    if (!kafka.groupId) {
      result.warnings.push({
        path: `${channelPath}.bindings.kafka`,
        message: `Kafka binding for "${channelName}" is missing "groupId" (consumerGroup) for reliable delivery`
      });
    }
    if (kafka.partitions && kafka.partitions < 1) {
      result.errors.push({
        path: `${channelPath}.bindings.kafka.partitions`,
        message: `Kafka partitions must be >= 1 for channel "${channelName}"`
      });
    }
    if (kafka.topicConfiguration) {
      if (kafka.topicConfiguration['retention.ms'] === undefined && kafka.topicConfiguration['retention.bytes'] === undefined) {
        result.warnings.push({
          path: `${channelPath}.bindings.kafka.topicConfiguration`,
          message: `Kafka topic configuration for "${channelName}" lacks retention policies (retention.ms or retention.bytes)`
        });
      }
    }
  }
}

function validateRefs(doc: any, result: AsyncAPIValidationResult): void {
  const refs = collectRefs(doc);
  for (const ref of refs) {
    if (ref.startsWith('#/')) {
      const resolved = resolveLocalRef(doc, ref);
      if (resolved === undefined) {
        result.errors.push({
          path: ref,
          message: `Unresolved $ref: "${ref}" does not point to a valid definition`
        });
      }
    }
  }
}

function collectRefs(obj: any, refs: string[] = []): string[] {
  if (obj && typeof obj === 'object') {
    if (obj['$ref'] && typeof obj['$ref'] === 'string') {
      refs.push(obj['$ref']);
    }
    for (const key of Object.keys(obj)) {
      collectRefs(obj[key], refs);
    }
  }
  return refs;
}

function resolveLocalRef(doc: any, ref: string): any {
  const parts = ref.replace('#/', '').split('/');
  let current = doc;
  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    current = current[part];
  }
  return current;
}

function findChannelForEvent(channels: Record<string, any>, eventName: string): { key: string; value: any } | null {
  if (!channels) return null;
  const lowerEvent = eventName.toLowerCase();

  for (const [key, value] of Object.entries(channels)) {
    if (key.toLowerCase().includes(lowerEvent)) {
      return { key, value };
    }
    // Also check message name
    const message = getMessageFromChannel(value);
    if (message && message.name && message.name.toLowerCase() === lowerEvent) {
      return { key, value };
    }
  }
  return null;
}

function getMessageFromChannel(channel: any): any | null {
  if (!channel) return null;
  if (channel.publish?.message) return channel.publish.message;
  if (channel.subscribe?.message) return channel.subscribe.message;
  return null;
}
