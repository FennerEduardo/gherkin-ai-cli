import { ParsedFeature } from '../core/gherkin-parser';
import { SpecificationIR } from '../core/semantic-ir';
import { GherkinAIConfig } from '../core/config';
import { featurePascalName } from '../utils/naming';

export function generateKotlinContracts(parsed: ParsedFeature, ir: SpecificationIR, config: GherkinAIConfig): string {
  const packageName = config.projectName ? config.projectName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() : 'com.example.app';
  const featurePascal = featurePascalName(parsed);

  let content = `// ==========================================================================
// Generated Kotlin Domain Contracts & DTOs
// Feature: ${parsed.featureName}
// Architecture: ${config.architecture}
// ==========================================================================
package ${packageName}.${featurePascal.toLowerCase()}

import java.util.UUID
import java.time.Instant

// 1. Domain Events
interface DomainEvent {
    val eventId: UUID
    val occurredOn: Instant
    val eventType: String
}

`;

  ir.events.forEach((ev, i) => {
    const eventNamePascal = ev.name.replace(/[^a-zA-Z0-9]/g, '');
    content += `data class ${eventNamePascal}Event(
    override val eventId: UUID = UUID.randomUUID(),
    override val occurredOn: Instant = Instant.now(),
    val payload: ${eventNamePascal}Payload
) : DomainEvent {
    override val eventType: String = "${eventNamePascal}"
}

data class ${eventNamePascal}Payload(
`;
    ir.fields.forEach((f, index) => {
      let ktType = f.type === 'number' ? 'Int' : f.type === 'boolean' ? 'Boolean' : 'String';
      content += `    val ${f.name}: ${ktType}${index < ir.fields.length - 1 ? ',' : ''}\n`;
    });
    content += `)\n\n`;
  });

  content += `// 2. Command DTOs\n`;
  content += `data class ${featurePascal}Command(
    val requestId: UUID,
    val timestamp: Instant,
    val payload: ${featurePascal}CommandPayload
)\n\n`;

  content += `data class ${featurePascal}CommandPayload(\n`;
  ir.fields.forEach((f, index) => {
    let ktType = f.type === 'number' ? 'Int' : f.type === 'boolean' ? 'Boolean' : 'String';
    content += `    val ${f.name}: ${ktType}${index < ir.fields.length - 1 ? ',' : ''}\n`;
  });
  content += `)\n\n`;

  content += `// 3. Domain Repository Port
interface ${featurePascal}Repository {
    fun findById(id: UUID): Any?
    fun save(entity: Any)
    fun delete(id: UUID)
}

// 4. Event Publisher Port
interface EventPublisher {
    fun publish(event: DomainEvent)
}
`;

  return content;
}
