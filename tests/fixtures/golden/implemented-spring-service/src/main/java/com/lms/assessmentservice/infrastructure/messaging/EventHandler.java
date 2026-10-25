package com.lms.assessmentservice.infrastructure.messaging;

/** Reacts to one event type consumed from RabbitMQ. Throwing dead-letters the message. */
public interface EventHandler {
    String eventType();

    void handle(IncomingEvent event) throws Exception;
}
