package com.lms.assessmentservice.runtime;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;

/**
 * Orchestrated saga: progress is persisted after every step; when a step fails, the completed steps
 * are compensated in reverse order. Re-running a saga id resumes after its completed steps.
 */
public class SagaOrchestrator {
    @FunctionalInterface
    public interface Action {
        void run() throws Exception;
    }

    public record Step(String name, Action action, Action compensate) {}

    public record Status(String status, List<String> completedSteps) {}

    private final ConnectionFactory connections;
    private final String s;

    public SagaOrchestrator(ConnectionFactory connections, String schema) {
        this.connections = connections;
        this.s = Schema.name(schema);
    }

    public String run(String sagaId, String tenantId, List<Step> steps) throws Exception {
        try (Connection conn = connections.open()) {
            CommandService.update(conn, "INSERT INTO " + s + ".ghk_sagas (id, tenant_id, status) VALUES (?, ?, 'RUNNING') ON CONFLICT (id) DO NOTHING", sagaId, tenantId);
            List<String> completed = new ArrayList<>(read(conn, sagaId).map(Status::completedSteps).orElse(List.of()));
            for (Step step : steps) {
                if (completed.contains(step.name())) continue;
                try {
                    step.action().run();
                } catch (Exception failure) {
                    save(conn, sagaId, "COMPENSATING", completed);
                    for (int i = completed.size() - 1; i >= 0; i--) {
                        String name = completed.get(i);
                        steps.stream().filter(x -> x.name().equals(name)).findFirst().orElseThrow().compensate().run();
                        completed.remove(i);
                        save(conn, sagaId, "COMPENSATING", completed);
                    }
                    save(conn, sagaId, "COMPENSATED", completed);
                    return "COMPENSATED";
                }
                completed.add(step.name());
                save(conn, sagaId, "RUNNING", completed);
            }
            save(conn, sagaId, "COMPLETED", completed);
            return "COMPLETED";
        }
    }

    public Optional<Status> status(String sagaId) throws SQLException {
        try (Connection conn = connections.open()) {
            return read(conn, sagaId);
        }
    }

    private Optional<Status> read(Connection conn, String sagaId) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement("SELECT status, completed_steps FROM " + s + ".ghk_sagas WHERE id = ?")) {
            ps.setString(1, sagaId);
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) return Optional.empty();
                String done = rs.getString(2);
                return Optional.of(new Status(rs.getString(1), done == null || done.isEmpty() ? List.of() : Arrays.asList(done.split(","))));
            }
        }
    }

    private void save(Connection conn, String sagaId, String status, List<String> completed) throws SQLException {
        CommandService.update(conn, "UPDATE " + s + ".ghk_sagas SET status = ?, completed_steps = ?, updated_at = now() WHERE id = ?", status, String.join(",", completed), sagaId);
    }
}
