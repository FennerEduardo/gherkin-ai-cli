package com.lms.assessmentservice.infrastructure.persistence;

import com.lms.assessmentservice.domain.shared.AggregateRoot;
import com.lms.assessmentservice.domain.shared.DomainException;
import org.springframework.jdbc.core.JdbcTemplate;

/** Insert for new aggregates (version 0), compare-and-set update for loaded ones. */
final class OptimisticSave {
    private OptimisticSave() {}

    static void save(JdbcTemplate jdbc, AggregateRoot aggregate, String insertSql, Object[] insertArgs, String updateSql, Object[] updateArgs) {
        long expected = aggregate.version();
        if (expected == 0) {
            jdbc.update(insertSql, insertArgs);
        } else if (jdbc.update(updateSql, updateArgs) == 0) {
            throw DomainException.conflict("CONCURRENT_MODIFICATION", "The resource was changed by another request; retry");
        }
        aggregate.persistedAs(expected + 1);
    }

    /** Appends (version + 1, id, expectedVersion) to the update arguments: "... version = ? WHERE id = ? AND version = ?". */
    static Object[] withVersion(AggregateRoot aggregate, String id, Object... columns) {
        Object[] args = new Object[columns.length + 3];
        System.arraycopy(columns, 0, args, 0, columns.length);
        args[columns.length] = aggregate.version() + 1;
        args[columns.length + 1] = id;
        args[columns.length + 2] = aggregate.version();
        return args;
    }
}
