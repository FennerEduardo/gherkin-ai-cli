export class OrderRepository {
  private readonly rows = new Map<string, { id: string; status: string }>();

  async findOne(id: string) {
    return this.rows.get(id);
  }

  async save(order: { id: string; status: string }) {
    this.rows.set(order.id, order);
  }
}
