// --------------------------------------------------------------------------
// Generador Frontend React 18 + Redux Toolkit / RTK Query
// --------------------------------------------------------------------------

export function generateReactReduxInfrastructure(featureName: string): string {
  const camelName = featureName.charAt(0).toLowerCase() + featureName.slice(1);
  const pascalName = featureName.charAt(0).toUpperCase() + featureName.slice(1);

  return `// React 18 + Redux Toolkit State & Client
import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import axios from 'axios';

export interface ${pascalName}State {
  items: any[];
  selectedItem: any | null;
  loading: boolean;
  error: string | null;
  tenantId: string | null;
}

const initialState: ${pascalName}State = {
  items: [],
  selectedItem: null,
  loading: false,
  error: null,
  tenantId: null
};

// Async Thunk para consumir API Backend
export const fetch${pascalName}List = createAsyncThunk(
  '${camelName}/fetchList',
  async (tenantId: string | undefined, { rejectWithValue }) => {
    try {
      const response = await axios.get(\`/api/v1/${camelName}\`, {
        headers: tenantId ? { 'X-Tenant-ID': tenantId } : {}
      });
      return response.data;
    } catch (err: any) {
      return rejectWithValue(err.response?.data?.message || 'Error al obtener datos');
    }
  }
);

export const execute${pascalName}Command = createAsyncThunk(
  '${camelName}/executeCommand',
  async (payload: { commandName: string; data: any; idempotencyKey?: string }, { rejectWithValue }) => {
    try {
      const headers: Record<string, string> = {};
      if (payload.idempotencyKey) {
        headers['X-Idempotency-Key'] = payload.idempotencyKey;
      }
      const response = await axios.post(\`/api/v1/${camelName}/commands\`, payload.data, { headers });
      return response.data;
    } catch (err: any) {
      return rejectWithValue(err.response?.data?.message || 'Error ejecutando comando');
    }
  }
);

export const ${camelName}Slice = createSlice({
  name: '${camelName}',
  initialState,
  reducers: {
    setTenantId: (state, action: PayloadAction<string>) => {
      state.tenantId = action.payload;
    },
    onRealtimeEventReceived: (state, action: PayloadAction<{ eventType: string; payload: any }>) => {
      state.items.unshift(action.payload);
    },
    resetState: (state) => {
      Object.assign(state, initialState);
    }
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetch${pascalName}List.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetch${pascalName}List.fulfilled, (state, action) => {
        state.loading = false;
        state.items = action.payload;
      })
      .addCase(fetch${pascalName}List.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload as string;
      });
  }
});

export const { setTenantId, onRealtimeEventReceived, resetState } = ${camelName}Slice.actions;
export default ${camelName}Slice.reducer;
`;
}
