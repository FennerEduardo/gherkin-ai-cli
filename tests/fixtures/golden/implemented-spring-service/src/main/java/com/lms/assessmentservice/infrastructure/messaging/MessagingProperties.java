package com.lms.assessmentservice.infrastructure.messaging;

import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * RabbitMQ wiring. The service publishes to the topic exchange "{service}.events" and consumes
 * from "{service}.consumer", which dead-letters to "{service}.dlq". Subscriptions are
 * "exchange:routingKey" pairs, e.g. "institution.events:MemberAdded".
 */
@ConfigurationProperties(prefix = "lms.messaging")
public record MessagingProperties(boolean enabled, String amqpUrl, String service, String producer, List<String> subscriptions,
                                  long relayIntervalMs, long inboxIntervalMs) {
    public MessagingProperties {
        subscriptions = subscriptions == null ? List.of() : List.copyOf(subscriptions);
        relayIntervalMs = relayIntervalMs <= 0 ? 500 : relayIntervalMs;
        inboxIntervalMs = inboxIntervalMs <= 0 ? 500 : inboxIntervalMs;
    }

    public String exchange() { return service + ".events"; }
    public String queue() { return service + ".consumer"; }
    public String deadLetterExchange() { return service + ".dlx"; }
    public String deadLetterQueue() { return service + ".dlq"; }
}
