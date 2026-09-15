export function generateVuePiniaStore(storeName: string): string {
  const camelName = storeName.charAt(0).toLowerCase() + storeName.slice(1);
  return `// --------------------------------------------------------------------------
// Pinia Store (Vue 3 Composition API)
// --------------------------------------------------------------------------
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import axios from 'axios';

export const use${storeName}Store = defineStore('${camelName}', () => {
  // State
  const data = ref<any[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const tenantId = ref<string | null>(null);

  // Getters
  const hasData = computed(() => data.value.length > 0);
  const activeCount = computed(() => data.value.length);

  // Actions
  async function fetchAll() {
    loading.value = true;
    error.value = null;
    try {
      const response = await axios.get('/api/${camelName}');
      data.value = response.data;
    } catch (err: any) {
      error.value = err.response?.data?.message || err.message || 'Error fetching data';
    } finally {
      loading.value = false;
    }
  }

  async function executeCommand(commandPayload: any, idempotencyKey?: string) {
    loading.value = true;
    error.value = null;
    try {
      const headers: Record<string, string> = {};
      if (tenantId.value) headers['X-Tenant-ID'] = tenantId.value;
      if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;

      const response = await axios.post('/api/${camelName}/commands', commandPayload, { headers });
      return response.data;
    } catch (err: any) {
      error.value = err.response?.data?.message || 'Error en comando';
      throw err;
    } finally {
      loading.value = false;
    }
  }

  function handleRealtimeEvent(event: any) {
    data.value.unshift(event);
  }

  return {
    data,
    loading,
    error,
    tenantId,
    hasData,
    activeCount,
    fetchAll,
    executeCommand,
    handleRealtimeEvent
  };
});
`;
}

export function generateVueComposable(composableName: string): string {
  const camelName = composableName.charAt(0).toLowerCase() + composableName.slice(1);
  const pascalName = composableName.charAt(0).toUpperCase() + composableName.slice(1);

  return `// --------------------------------------------------------------------------
// Vue Composable (Realtime SSE / WebSocket Events)
// --------------------------------------------------------------------------
import { ref, onMounted, onUnmounted } from 'vue';

export function use${pascalName}(channelName: string = '${camelName}', onEventCallback?: (data: any) => void) {
  const isConnected = ref(false);
  const error = ref<string | null>(null);
  let eventSource: EventSource | null = null;

  onMounted(() => {
    try {
      eventSource = new EventSource(\`/api/v1/events/stream?channel=\${channelName}\`);
      eventSource.onopen = () => { isConnected.value = true; };
      eventSource.onmessage = (e) => {
        const payload = JSON.parse(e.data);
        if (onEventCallback) onEventCallback(payload);
      };
      eventSource.onerror = (err) => {
        error.value = 'Conexión realtime interrumpiéndose...';
        isConnected.value = false;
      };
    } catch (e: any) {
      error.value = e.message;
    }
  });

  onUnmounted(() => {
    if (eventSource) {
      eventSource.close();
    }
  });

  return {
    isConnected,
    error
  };
}
`;
}
