// --------------------------------------------------------------------------
// Generador del Servicio Cliente SignalR para Angular 17+
// --------------------------------------------------------------------------

export function generateAngularSignalRService(featureName: string): string {
  const camelName = featureName.charAt(0).toLowerCase() + featureName.slice(1);
  const pascalName = featureName.charAt(0).toUpperCase() + featureName.slice(1);

  return `// --------------------------------------------------------------------------
// Angular SignalR Client Service (@microsoft/signalr)
// --------------------------------------------------------------------------
import { Injectable, inject, signal } from '@angular/core';
import * as signalR from '@microsoft/signalr';
import { ${pascalName}SignalStore } from './${camelName}.store';

@Injectable({
  providedIn: 'root'
})
export class SignalRNotificationService {
  private hubConnection!: signalR.HubConnection;
  private store = inject(${pascalName}SignalStore);

  public isConnected = signal<boolean>(false);
  public connectionError = signal<string | null>(null);

  public startConnection(hubUrl: string = '/hubs/domain-events', tenantId?: string): void {
    this.hubConnection = new signalR.HubConnectionBuilder()
      .withUrl(hubUrl)
      .withAutomaticReconnect([0, 2000, 5000, 10000])
      .configureLogging(signalR.LogLevel.Information)
      .build();

    this.hubConnection
      .start()
      .then(() => {
        this.isConnected.set(true);
        this.connectionError.set(null);
        if (tenantId) {
          this.hubConnection.invoke('SubscribeToTenant', tenantId);
        }
      })
      .catch((err) => {
        this.isConnected.set(false);
        this.connectionError.set(err.toString());
      });

    this.registerEventHandlers();
  }

  private registerEventHandlers(): void {
    this.hubConnection.on('ReceiveDomainEvent', (eventType: string, payload: string) => {
      try {
        const data = JSON.parse(payload);
        this.store.onRealtimeStatusUpdate(data);
      } catch (e) {
        console.error('Error parseando evento SignalR:', e);
      }
    });

    this.hubConnection.on('ReceiveSagaStateChanged', (sagaId: string, currentState: string) => {
      console.log(\`Saga \${sagaId} cambió a estado: \${currentState}\`);
    });
  }

  public stopConnection(): void {
    if (this.hubConnection) {
      this.hubConnection.stop();
      this.isConnected.set(false);
    }
  }
}
`;
}
