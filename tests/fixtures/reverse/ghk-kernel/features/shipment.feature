@aggregate:Shipment @command:DispatchShipment @event:ShipmentDispatched
Feature: Shipment
  As an operator
  I want to dispatch shipments

  Scenario: Dispatch a shipment
    Given a packed shipment
    When the operator dispatches the shipment
    Then the shipment is dispatched
