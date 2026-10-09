/* ==========================================================================
   gherkin-ai-cli - Application layer for Laravel over the PHP runtime
   kernel: controller with a JWT tenant, command port (CommandService from
   DATABASE_URL), `artisan outbox:relay`, and tests. Contract: ./shared.ts.
   ========================================================================== */

import type { DomainModel } from '../domain-model';
import { commandRoute, RELAY_INTERVAL_MS } from './shared';

export interface PhpAppFile {
  filename: string;
  content: string;
}

const php = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const head = (ns: string) => `<?php\n\ndeclare(strict_types=1);\n\nnamespace ${ns};\n\n`;

export function renderLaravelAppLayer(m: DomainModel, claim: string): PhpAppFile[] {
  const first = m.commands[0];
  const route = commandRoute(m);

  const jwt = `${head('App\\Auth')}/**
 * HS256 bearer tokens. The tenant comes only from the ${php(claim)} claim of a validated token, never from
 * a header such as X-Tenant-Id, and there is no default tenant.
 */
final class JwtTenant
{
    public const TENANT_CLAIM = ${php(claim)};

    private static function decode(string $part): string|false
    {
        return base64_decode(strtr($part, '-_', '+/') . str_repeat('=', (4 - strlen($part) % 4) % 4), true);
    }

    private static function encode(string $data): string
    {
        return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
    }

    /** Tenant claim of a valid token (signature, exp, nbf checked), else null. */
    public static function tenantFrom(?string $authorization, ?string $secret): ?string
    {
        if ($secret === null || $secret === '' || $authorization === null || stripos($authorization, 'Bearer ') !== 0) {
            return null;
        }
        $parts = explode('.', trim(substr($authorization, 7)));
        if (count($parts) !== 3) {
            return null;
        }
        $header = json_decode((string) self::decode($parts[0]), true);
        if (!is_array($header) || ($header['alg'] ?? null) !== 'HS256') {
            return null;
        }
        $signature = self::decode($parts[2]);
        if ($signature === false || !hash_equals(hash_hmac('sha256', "{$parts[0]}.{$parts[1]}", $secret, true), $signature)) {
            return null;
        }
        $claims = json_decode((string) self::decode($parts[1]), true);
        if (!is_array($claims)) {
            return null;
        }
        $now = time();
        if (is_numeric($claims['exp'] ?? null) && $now >= $claims['exp']) {
            return null;
        }
        if (is_numeric($claims['nbf'] ?? null) && $now < $claims['nbf']) {
            return null;
        }
        $tenant = $claims[self::TENANT_CLAIM] ?? null;
        return is_string($tenant) && trim($tenant) !== '' ? $tenant : null;
    }

    /** Signs an HS256 token (tests and local tooling; production tokens come from your identity provider). */
    public static function sign(array $claims, string $secret): string
    {
        $head = self::encode('{"alg":"HS256","typ":"JWT"}');
        $body = self::encode(json_encode($claims, JSON_THROW_ON_ERROR));
        return "{$head}.{$body}." . self::encode(hash_hmac('sha256', "{$head}.{$body}", $secret, true));
    }
}
`;

  const port = `${head('App\\Application')}/** What the HTTP layer needs from the runtime kernel (RuntimeCommandPort in production, a fake in tests). */
interface CommandPort
{
    /**
     * @param array<string, mixed> $payload
     * @return array{status: string, aggregateId: string, eventType: ?string, version: ?int}
     */
    public function handle(string $tenantId, string $aggregateId, string $command, array $payload = [], ?string $idempotencyKey = null, ?string $traceparent = null): array;
}
`;

  const runtimePort = `${head('App\\Application')}use App\\Runtime\\CommandService;

/** CommandPort over the runtime kernel's CommandService (DATABASE_URL). */
final class RuntimeCommandPort implements CommandPort
{
    private ?CommandService $service = null;

    public function __construct(private readonly string $databaseUrl)
    {
    }

    public function handle(string $tenantId, string $aggregateId, string $command, array $payload = [], ?string $idempotencyKey = null, ?string $traceparent = null): array
    {
        $this->service ??= new CommandService($this->databaseUrl);
        return $this->service->handle($tenantId, $aggregateId, $command, $payload, $idempotencyKey, $traceparent);
    }
}
`;

  const provider = `${head('App\\Providers')}use App\\Application\\CommandPort;
use App\\Application\\RuntimeCommandPort;
use Illuminate\\Support\\ServiceProvider;

final class RuntimeServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(CommandPort::class, fn () => new RuntimeCommandPort((string) env('DATABASE_URL', '')));
    }
}
`;

  const controller = `${head('App\\Http\\Controllers')}use App\\Application\\CommandPort;
use App\\Auth\\JwtTenant;
use App\\Domain\\${m.pascal}\\DomainValidationException;
use Illuminate\\Http\\JsonResponse;
use Illuminate\\Http\\Request;

/** POST ${route}/{id}/{command} (${m.commands.map(c => c.snake).join(', ')}). */
// ghk:implements ${m.pascal}
final class ${m.pascal}Controller
{
    private const STATUS = ['created' => 202, 'replayed' => 200, 'in-progress' => 409];

    public function __construct(private readonly CommandPort $commands)
    {
    }

    public function execute(Request $request, string $id, string $command): JsonResponse
    {
        $tenant = JwtTenant::tenantFrom($request->header('Authorization'), (string) (config('app.jwt_secret') ?? env('JWT_SECRET', '')));
        if ($tenant === null) {
            return response()->json(['detail' => 'A valid bearer token with a tenant is required'], 401);
        }
        try {
            $result = $this->commands->handle($tenant, $id, $command, $request->all(), $request->header('Idempotency-Key'), $request->header('traceparent'));
        } catch (DomainValidationException $e) {
            return response()->json(['detail' => $e->getMessage()], 422);
        }
        return response()->json($result, self::STATUS[$result['status']] ?? 200);
    }
}
`;

  const relayCommand = `${head('App\\Console\\Commands')}use App\\Runtime\\Messaging;
use App\\Runtime\\OutboxRelay;
use Illuminate\\Console\\Command;

/** php artisan outbox:relay — publishes the outbox to RabbitMQ every ${RELAY_INTERVAL_MS} ms (DATABASE_URL, AMQP_URL). */
final class OutboxRelayCommand extends Command
{
    protected $signature = 'outbox:relay';
    protected $description = 'Publish the transactional outbox to RabbitMQ until stopped.';

    public function handle(): int
    {
        $connection = Messaging::connect((string) env('AMQP_URL'));
        $channel = $connection->channel();
        $topology = Messaging::forPrefix();
        $topology->declare($channel);
        $relay = new OutboxRelay((string) env('DATABASE_URL'), $channel, $topology->exchange);
        $workerId = ${php(m.kebab + '-')} . bin2hex(random_bytes(6));
        while (true) {
            $relay->publishBatch($workerId);
            usleep(${RELAY_INTERVAL_MS * 1000});
        }
    }
}
`;

  const featureTest = `${head('Tests\\Feature')}use App\\Application\\CommandPort;
use App\\Auth\\JwtTenant;
use App\\Domain\\${m.pascal}\\DomainValidationException;
use Tests\\TestCase;

final class ${m.pascal}ApiTest extends TestCase
{
    private const SECRET = 'unit-test-secret-with-at-least-32-chars';

    /** @var list<array<int, mixed>> */
    public array $calls = [];

    protected function setUp(): void
    {
        parent::setUp();
        config(['app.jwt_secret' => self::SECRET]);
        $test = $this;
        $this->app->instance(CommandPort::class, new class ($test) implements CommandPort {
            public function __construct(private readonly ${m.pascal}ApiTest $test)
            {
            }

            public function handle(string $tenantId, string $aggregateId, string $command, array $payload = [], ?string $idempotencyKey = null, ?string $traceparent = null): array
            {
                $this->test->calls[] = [$tenantId, $aggregateId, $command, $payload];
                if ($command === 'does_not_exist') {
                    throw new DomainValidationException("Unknown command {$command}");
                }
                return ['status' => $idempotencyKey === 'seen' ? 'replayed' : 'created', 'aggregateId' => $aggregateId, 'eventType' => ${php(first.event)}, 'version' => 1];
            }
        });
    }

    private function bearer(array $claims, string $secret = self::SECRET): array
    {
        return ['Authorization' => 'Bearer ' . JwtTenant::sign($claims, $secret)];
    }

    public function test_health_endpoint(): void
    {
        $this->get('/up')->assertOk();
    }

    public function test_runs_a_command_for_the_token_tenant(): void
    {
        $this->postJson(${php(route + '/agg-api/' + first.snake)}, ['source' => 'api-test'], $this->bearer([JwtTenant::TENANT_CLAIM => 'acme']) + ['X-Tenant-Id' => 'someone-else'])
            ->assertStatus(202)
            ->assertJsonPath('status', 'created');
        self::assertSame(['acme', 'agg-api', ${php(first.snake)}, ['source' => 'api-test']], end($this->calls));
    }

    public function test_idempotent_replay_returns_200(): void
    {
        $this->postJson(${php(route + '/agg-api/' + first.snake)}, [], $this->bearer([JwtTenant::TENANT_CLAIM => 'acme']) + ['Idempotency-Key' => 'seen'])->assertOk();
    }

    public function test_rejects_missing_or_invalid_tokens_and_x_tenant_id(): void
    {
        $url = ${php(route + '/agg-api/' + first.snake)};
        $this->postJson($url)->assertUnauthorized();
        $this->postJson($url, [], ['X-Tenant-Id' => 'acme'])->assertUnauthorized();
        $this->postJson($url, [], $this->bearer(['sub' => 'u1']))->assertUnauthorized();
        $this->postJson($url, [], $this->bearer([JwtTenant::TENANT_CLAIM => 'acme'], 'wrong'))->assertUnauthorized();
    }

    public function test_domain_validation_error_is_422(): void
    {
        $this->postJson(${php(route + '/agg-api/does_not_exist')}, [], $this->bearer([JwtTenant::TENANT_CLAIM => 'acme']))->assertStatus(422);
    }
}
`;

  const integrationTest = `${head('Tests\\Integration')}use App\\Auth\\JwtTenant;
use App\\Runtime\\Database;
use App\\Runtime\\Schema;
use PHPUnit\\Framework\\Attributes\\Group;
use Tests\\TestCase;

/** HTTP contract of the application layer against PostgreSQL (needs DATABASE_URL). */
#[Group('integration')]
final class ${m.pascal}HttpTest extends TestCase
{
    private const SECRET = 'integration-test-secret-with-32-chars!';

    public function test_runs_a_command_into_the_outbox_for_the_token_tenant_idempotently(): void
    {
        $url = (string) getenv('DATABASE_URL');
        Schema::migrate($url);
        config(['app.jwt_secret' => self::SECRET]);
        $tenant = 'tenant-' . bin2hex(random_bytes(6));
        $id = 'agg-' . bin2hex(random_bytes(6));
        $headers = ['Authorization' => 'Bearer ' . JwtTenant::sign([JwtTenant::TENANT_CLAIM => $tenant], self::SECRET), 'Idempotency-Key' => bin2hex(random_bytes(8)), 'X-Tenant-Id' => 'someone-else'];
        $path = ${php(route + '/')} . $id . ${php('/' + first.snake)};

        $this->postJson($path, [], ['X-Tenant-Id' => $tenant])->assertUnauthorized();
        $this->postJson($path, [], $headers)->assertStatus(202);
        $this->postJson($path, [], $headers)->assertOk()->assertJsonPath('status', 'replayed');

        $rows = Database::rows(Database::connect($url), 'SELECT tenant_id FROM ghk_outbox WHERE aggregate_id = ?', [$id]);
        self::assertSame([['tenant_id' => $tenant]], $rows);
    }
}
`;

  return [
    { filename: 'app/Auth/JwtTenant.php', content: jwt },
    { filename: 'app/Application/CommandPort.php', content: port },
    { filename: 'app/Application/RuntimeCommandPort.php', content: runtimePort },
    { filename: 'app/Providers/RuntimeServiceProvider.php', content: provider },
    { filename: `app/Http/Controllers/${m.pascal}Controller.php`, content: controller },
    { filename: 'app/Console/Commands/OutboxRelayCommand.php', content: relayCommand },
    { filename: `tests/Feature/${m.pascal}ApiTest.php`, content: featureTest },
    { filename: `tests/Integration/${m.pascal}HttpTest.php`, content: integrationTest }
  ];
}
