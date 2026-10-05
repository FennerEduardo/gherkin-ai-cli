import { featurePascalName } from '../../utils/naming';
// --------------------------------------------------------------------------
// CQRS Architecture for Java 21 / Spring Boot 3
// FIXED: Generates separate files per public class (Java requirement)
// PARAMETRIZED: Uses feature name instead of hardcoded 'Payment'
// --------------------------------------------------------------------------

export function generateJavaCQRSInfrastructure(packageName: string, featureName?: string): { filename: string; content: string }[] {
  const feature = featureName
    ? featurePascalName(featureName)
    : 'Payment';
  const featureLower = feature.charAt(0).toLowerCase() + feature.slice(1);

  const commands = `package ${packageName}.application.cqrs;

import java.util.UUID;

/**
 * CQRS Commands for ${feature} domain.
 * Commands are immutable records (Java 21) that represent intent.
 */
public record Create${feature}Command(UUID tenantId, java.util.Map<String, Object> payload) {}
`;

  const queries = `package ${packageName}.application.cqrs;

import java.util.UUID;

/**
 * CQRS Queries for ${feature} domain.
 */
public record Get${feature}Query(UUID ${featureLower}Id) {}
`;

  const events = `package ${packageName}.application.cqrs;

import java.util.UUID;

/**
 * Domain Events for ${feature}.
 */
public record ${feature}CreatedEvent(UUID ${featureLower}Id, UUID tenantId) {}
`;

  const dto = `package ${packageName}.application.cqrs;

import java.util.UUID;

/**
 * Data Transfer Object for ${feature} read model.
 */
public record ${feature}DTO(UUID ${featureLower}Id, String status, java.util.Map<String, Object> data) {}
`;

  const commandHandler = `package ${packageName}.application.cqrs;

import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.util.UUID;

/**
 * Command Handler for Create${feature}.
 * Follows CQRS: writes to the write model and publishes domain events.
 */
@Service
public class Create${feature}CommandHandler {
    private final ApplicationEventPublisher eventPublisher;

    public Create${feature}CommandHandler(ApplicationEventPublisher eventPublisher) {
        this.eventPublisher = eventPublisher;
    }

    @Transactional
    public UUID handle(Create${feature}Command command) {
        UUID ${featureLower}Id = UUID.randomUUID();

        // 1. Save to Write Model (Domain DB)
        // repository.save(new ${feature}(${featureLower}Id, command.tenantId(), command.payload()));

        // 2. Publish Domain Event
        eventPublisher.publishEvent(new ${feature}CreatedEvent(${featureLower}Id, command.tenantId()));
        return ${featureLower}Id;
    }
}
`;

  const queryHandler = `package ${packageName}.application.cqrs;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.util.Map;

/**
 * Query Handler for ${feature} read model.
 * Follows CQRS: reads from optimized read model / projected views.
 */
@Service
public class Get${feature}QueryHandler {
    @Transactional(readOnly = true)
    public ${feature}DTO handle(Get${feature}Query query) {
        // Optimized read from Read Model / Projected View
        return new ${feature}DTO(query.${featureLower}Id(), "PROCESSED", Map.of());
    }
}
`;

  return [
    { filename: `application/cqrs/Create${feature}Command.java`, content: commands },
    { filename: `application/cqrs/Get${feature}Query.java`, content: queries },
    { filename: `application/cqrs/${feature}CreatedEvent.java`, content: events },
    { filename: `application/cqrs/${feature}DTO.java`, content: dto },
    { filename: `application/cqrs/Create${feature}CommandHandler.java`, content: commandHandler },
    { filename: `application/cqrs/Get${feature}QueryHandler.java`, content: queryHandler },
  ];
}
