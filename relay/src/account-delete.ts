export interface AccountDeletionContext<Socket> {
  getWebSockets(): Iterable<Socket>;
  storage: { deleteAll(): Promise<void> };
}

export async function deleteAccountState<Socket>(
  ctx: AccountDeletionContext<Socket>,
  close: (socket: Socket, code: number, reason: string) => void,
): Promise<void> {
  for (const socket of ctx.getWebSockets()) close(socket, 4001, "signed out");
  await ctx.storage.deleteAll();
}
