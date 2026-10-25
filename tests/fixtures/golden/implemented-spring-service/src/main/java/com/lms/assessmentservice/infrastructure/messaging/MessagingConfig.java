package com.lms.assessmentservice.infrastructure.messaging;

import com.lms.assessmentservice.infrastructure.web.RequestContext;
import com.lms.assessmentservice.runtime.InboxConsumer;
import com.lms.assessmentservice.runtime.OutboxRelay;
import com.rabbitmq.client.Channel;
import com.rabbitmq.client.Connection;
import com.rabbitmq.client.ConnectionFactory;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;
import javax.sql.DataSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.Scheduled;

/**
 * Runs the ghk runtime kernel inside Spring: runtime/OutboxRelay publishes the outbox and
 * runtime/InboxConsumer consumes subscribed events with inbox deduplication and DLQ on failure.
 * Disabled (lms.messaging.enabled=false) in tests that have no broker.
 */
@Configuration
@ConditionalOnProperty(prefix = "lms.messaging", name = "enabled", havingValue = "true")
public class MessagingConfig {
    private static final Logger log = LoggerFactory.getLogger(MessagingConfig.class);

    @Bean(destroyMethod = "close")
    Connection amqpConnection(MessagingProperties props) throws Exception {
        var factory = new ConnectionFactory();
        factory.setUri(props.amqpUrl());
        factory.setAutomaticRecoveryEnabled(true);
        Connection connection = factory.newConnection(props.service() + "-service");
        try (Channel channel = connection.createChannel()) {
            declareTopology(channel, props);
        }
        return connection;
    }

    /** Own exchange; own queue dead-lettering to DLX -> DLQ; queue bound to each subscribed event. */
    static void declareTopology(Channel channel, MessagingProperties props) throws Exception {
        channel.exchangeDeclare(props.exchange(), "topic", true);
        channel.exchangeDeclare(props.deadLetterExchange(), "fanout", true);
        channel.queueDeclare(props.deadLetterQueue(), true, false, false, null);
        channel.queueBind(props.deadLetterQueue(), props.deadLetterExchange(), "");
        channel.queueDeclare(props.queue(), true, false, false, Map.of("x-dead-letter-exchange", props.deadLetterExchange()));
        for (String subscription : props.subscriptions()) {
            String[] parts = subscription.split(":", 2);
            channel.exchangeDeclare(parts[0], "topic", true);
            channel.queueBind(props.queue(), parts[0], parts[1]);
        }
    }

    @Bean
    RelayJob outboxRelayJob(Connection amqp, DataSource dataSource, MessagingProperties props) throws Exception {
        return new RelayJob(new OutboxRelay(dataSource::getConnection, amqp.createChannel(), props.exchange(), "public"),
            props.service() + "-" + UUID.randomUUID());
    }

    @Bean
    InboxJob inboxJob(Connection amqp, DataSource dataSource, MessagingProperties props, List<EventHandler> handlers) throws Exception {
        Map<String, EventHandler> byType = handlers.stream().collect(Collectors.toMap(EventHandler::eventType, Function.identity()));
        InboxConsumer consumer = new InboxConsumer(dataSource::getConnection, amqp.createChannel(), props.queue(), props.service() + "-service",
            (envelope, meta) -> dispatch(byType, envelope, meta), "public");
        return new InboxJob(consumer);
    }

    @SuppressWarnings("unchecked")
    private static void dispatch(Map<String, EventHandler> handlers, Map<String, Object> envelope, InboxConsumer.Meta meta) throws Exception {
        EventHandler handler = handlers.get(meta.eventType());
        if (handler == null) {
            log.warn("No handler for {} {}; acknowledged without effect", meta.eventType(), meta.messageId());
            return;
        }
        String correlationId = (String) envelope.get("correlationId");
        RequestContext.set(correlationId, meta.messageId());
        try {
            var payload = (Map<String, Object>) envelope.getOrDefault("payload", Map.of());
            handler.handle(new IncomingEvent(meta.messageId(), meta.eventType(), meta.tenantId(), correlationId, payload, meta.connection()));
        } finally {
            RequestContext.clear();
        }
    }

    public static class RelayJob {
        private final OutboxRelay relay;
        private final String workerId;

        RelayJob(OutboxRelay relay, String workerId) {
            this.relay = relay;
            this.workerId = workerId;
        }

        @Scheduled(fixedDelayString = "${lms.messaging.relay-interval-ms:500}")
        public void publish() {
            try {
                relay.publishBatch(workerId, 100);
            } catch (Exception e) {
                log.error("Outbox relay failed; retrying on the next run", e);
            }
        }
    }

    public static class InboxJob {
        private final InboxConsumer consumer;

        InboxJob(InboxConsumer consumer) {
            this.consumer = consumer;
        }

        @Scheduled(fixedDelayString = "${lms.messaging.inbox-interval-ms:500}")
        public void consume() {
            try {
                consumer.drain(200);
            } catch (Exception e) {
                log.error("Inbox consumer failed; retrying on the next run", e);
            }
        }
    }
}
