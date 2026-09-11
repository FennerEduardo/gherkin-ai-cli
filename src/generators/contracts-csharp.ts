/* ==========================================================================
   gherkin-ai-cli - C# 11/12 Domain Driven Design Contracts & Base Classes
   ========================================================================== */

import { ParsedFeature } from '../core/gherkin-parser';
import { GherkinAIConfig } from '../core/config';
import { SpecificationIR } from '../core/semantic-ir';

export function generateCsharpContracts(parsed: ParsedFeature, ir: SpecificationIR, config: GherkinAIConfig): string {
  const featurePascal = parsed.featureName.replace(/[^a-zA-Z0-9]/g, '');
  const namespace = config.projectName ? config.projectName.replace(/[^a-zA-Z0-9]/g, '') : 'Domain';

  return `/* ==========================================================================
   Generated Strongly-Typed DDD Contracts & Base Classes
   Feature: ${parsed.featureName}
   Namespace: ${namespace}.Domain.${featurePascal}
   ========================================================================== */

namespace ${namespace}.Domain.${featurePascal};

using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

// --------------------------------------------------------------------------
// 1. Core DDD Interfaces & Base Classes
// --------------------------------------------------------------------------
public interface IDomainEvent
{
    Guid EventId { get; }
    DateTime OccurredOn { get; }
    string EventType { get; }
}

public abstract class AggregateRoot<TId>
{
    public TId Id { get; protected set; } = default!;
    public long Version { get; protected set; }
    private readonly List<IDomainEvent> _uncommittedEvents = new();

    public IReadOnlyCollection<IDomainEvent> GetUncommittedEvents() => _uncommittedEvents.AsReadOnly();
    public void ClearUncommittedEvents() => _uncommittedEvents.Clear();

    protected void ApplyChange(IDomainEvent @event)
    {
        _uncommittedEvents.Add(@event);
        Version++;
    }
}

public abstract class ValueObject
{
    protected abstract IEnumerable<object> GetEqualityComponents();

    public override boolean Equals(object? obj)
    {
        if (obj == null || obj.GetType() != GetType()) return false;
        var other = (ValueObject)obj;
        return GetEqualityComponents().SequenceEqual(other.GetEqualityComponents());
    }

    public override int GetHashCode()
    {
        return GetEqualityComponents()
            .Aggregate(1, (current, obj) => current * 23 + (obj?.GetHashCode() ?? 0));
    }
}

// --------------------------------------------------------------------------
// 2. Strongly-Typed Domain Event Records
// --------------------------------------------------------------------------
${ir.events.length > 0 ? ir.events.map((ev, i) => `public record ${ev.name.replace(/[^a-zA-Z0-9]/g, '')}Event(
    Guid EventId,
    DateTime OccurredOn,
    Guid AggregateId,
    string Details
) : IDomainEvent { public string EventType => nameof(${ev.name.replace(/[^a-zA-Z0-9]/g, '')}Event); }`).join('\n\n') : `public record ${featurePascal}ProcessedEvent(
    Guid EventId,
    DateTime OccurredOn,
    Guid AggregateId,
    string Details
) : IDomainEvent { public string EventType => nameof(${featurePascal}ProcessedEvent); }`}

// --------------------------------------------------------------------------
// 3. Strongly-Typed Command & Query Records
// --------------------------------------------------------------------------
public record Create${featurePascal}Command(
    Guid RequestId,
    Guid TenantId,
    DateTime Timestamp,
    string ReferenceCode,
    decimal Amount
);

public record Get${featurePascal}Query(
    Guid ${featurePascal}Id,
    Guid TenantId
);

// --------------------------------------------------------------------------
// 4. Strongly-Typed Domain Repository Port
// --------------------------------------------------------------------------
public interface I${featurePascal}Repository
{
    Task<${featurePascal}Aggregate?> FindByIdAsync(Guid id);
    Task SaveAsync(${featurePascal}Aggregate entity);
    Task DeleteAsync(Guid id);
}

public class ${featurePascal}Aggregate : AggregateRoot<Guid>
{
    public string ReferenceCode { get; private set; } = string.Empty;
    public decimal Amount { get; private set; }

    public ${featurePascal}Aggregate() { }

    public ${featurePascal}Aggregate(Guid id, string referenceCode, decimal amount)
    {
        Id = id;
        ReferenceCode = referenceCode;
        Amount = amount;
        ApplyChange(new ${featurePascal}ProcessedEvent(Guid.NewGuid(), DateTime.UtcNow, Id, $"Created ${featurePascal}"));
    }
}

// --------------------------------------------------------------------------
// 5. Application Event Publisher Port
// --------------------------------------------------------------------------
public interface IEventPublisher
{
    Task PublishAsync(IDomainEvent domainEvent);
}
`;
}
