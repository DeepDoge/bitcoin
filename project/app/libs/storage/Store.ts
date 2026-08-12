export abstract class Store {
	public abstract size(): bigint;
	public abstract reveal(size: bigint | number): void;
	public abstract truncate(size: bigint | number): void;
	public abstract sync(): void;
}
