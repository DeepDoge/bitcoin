export abstract class Store {
	public abstract sync(): void;
	public abstract recover(snapshot: number): void;
	public abstract snapshot(): number;
}
