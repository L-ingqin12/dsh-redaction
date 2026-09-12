export const name = 'x-late-dialogs'
// Provides tuiDialogs only AFTER a delay, so a consumer row that injects it
// must sit PENDING and then be reactivated when the service finally appears.
export async function apply(ctx) {
  await new Promise((resolve) => setTimeout(resolve, 300))
  ctx.provide('tuiDialogs', { select: async () => undefined })
}
