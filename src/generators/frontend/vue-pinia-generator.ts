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

  // Getters
  const hasData = computed(() => data.value.length > 0);

  // Actions
  async function fetchAll() {
    loading.value = true;
    error.value = null;
    try {
      const response = await axios.get('/api/${camelName}');
      data.value = response.data;
    } catch (err: any) {
      error.value = err.message || 'Error fetching data';
    } finally {
      loading.value = false;
    }
  }

  return {
    data,
    loading,
    error,
    hasData,
    fetchAll
  };
});
`;
}

export function generateVueComposable(composableName: string): string {
  const camelName = composableName.charAt(0).toLowerCase() + composableName.slice(1);
  return `// --------------------------------------------------------------------------
// Vue Composable (Reusabilidad Lógica / Logic Reusability)
// --------------------------------------------------------------------------
import { ref, onMounted } from 'vue';

export function use${composableName}() {
  const isReady = ref(false);

  onMounted(() => {
    // Inicialización lógica / Logic initialization
    isReady.value = true;
  });

  return {
    isReady
  };
}
`;
}
