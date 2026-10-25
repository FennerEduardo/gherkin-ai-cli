package com.lms.assessmentservice.runtime;

import com.rabbitmq.client.Channel;
import java.io.IOException;
import java.util.Map;

/** Topic exchange -> consumer queue, which dead-letters rejected messages to a fanout DLX -> DLQ. */
public record Topology(String exchange, String queue, String dlx, String dlq) {
    public static final Topology DEFAULT = new Topology("grade.events", "grade.consumer", "grade.dlx", "grade.dlq");

    public static Topology forPrefix(String prefix) {
        return new Topology(prefix + ".events", prefix + ".consumer", prefix + ".dlx", prefix + ".dlq");
    }

    public void declare(Channel channel) throws IOException {
        channel.exchangeDeclare(exchange, "topic", true);
        channel.exchangeDeclare(dlx, "fanout", true);
        channel.queueDeclare(dlq, true, false, false, null);
        channel.queueBind(dlq, dlx, "");
        channel.queueDeclare(queue, true, false, false, Map.of("x-dead-letter-exchange", dlx));
        channel.queueBind(queue, exchange, "#");
    }
}
