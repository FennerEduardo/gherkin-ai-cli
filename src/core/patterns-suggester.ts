export function suggestPatterns(stack: any, architecture: string) {
  const designPatterns: string[] = [];
  const codingRules: string[] = [
    'Write clean, self-documenting code',
    'Follow DRY and SOLID principles',
    'Ensure proper error handling and logging'
  ];

  // Patterns based on architecture
  if (architecture === 'hexagonal' || architecture === 'clean') {
    designPatterns.push('Ports and Adapters', 'Repository Pattern', 'Dependency Injection');
    codingRules.push('Core domain must not depend on external frameworks');
  } else if (architecture === 'cqrs') {
    designPatterns.push('Command Query Responsibility Segregation (CQRS)', 'Event Sourcing (Optional)', 'Mediator Pattern');
  }

  // Patterns based on framework
  const framework = stack.framework?.toLowerCase() || '';
  const language = stack.language?.toLowerCase() || '';

  if (framework.includes('react') || framework.includes('next')) {
    designPatterns.push('Hooks Pattern', 'Atomic Design', 'Component-Based Architecture');
    codingRules.push('Use functional components and hooks', 'Avoid prop drilling, use context or state management');
  } else if (framework.includes('angular')) {
    designPatterns.push('Observable Pattern (RxJS)', 'Dependency Injection', 'Singleton Services');
    codingRules.push('Use strict TypeScript', 'Unsubscribe from observables to prevent memory leaks');
  } else if (framework.includes('spring')) {
    designPatterns.push('MVC Pattern', 'Repository Pattern', 'Factory Pattern');
    codingRules.push('Use constructor injection over field injection (@Autowired)', 'Use Lombok for boilerplate reduction if applicable');
  } else if (framework.includes('nestjs')) {
    designPatterns.push('Module Pattern', 'Dependency Injection', 'Decorators');
    codingRules.push('Keep controllers thin, delegate logic to services', 'Use DTOs with validation pipes');
  } else if (framework.includes('laravel')) {
    designPatterns.push('MVC Pattern', 'Active Record (Eloquent)', 'Facade Pattern');
    codingRules.push('Use Form Requests for validation', 'Fat models, skinny controllers');
  }

  // Language specific rules
  if (language === 'typescript') {
    codingRules.push('Use strict typings, avoid "any"', 'Prefer interfaces over types for object shapes');
  } else if (language === 'python') {
    codingRules.push('Follow PEP-8 style guide', 'Use type hints (PEP 484)');
  } else if (language === 'go') {
    codingRules.push('Handle errors explicitly (if err != nil)', 'Prefer composition over inheritance');
  }

  return {
    designPatterns: Array.from(new Set(designPatterns)),
    codingRules: Array.from(new Set(codingRules))
  };
}
