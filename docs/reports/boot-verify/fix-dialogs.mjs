export const name = 'x-dialogs'
export function apply(ctx) {
  ctx.provide('tuiDialogs', {
    select: async () => undefined,
  })
}
