// The only extension added by the workbench. No filesystem, shell or network access.
export default function workbenchQuestions(pi) {
  pi.registerTool({
    name: 'workbench_ask_user', label: '询问用户',
    description: 'Ask the user for a task decision and wait for their answer. Never request passwords, API keys or tokens.',
    parameters: { type: 'object', properties: { question: { type: 'string', minLength: 1 },
      options: { type: 'array', items: { type: 'string' }, maxItems: 20 } }, required: ['question'], additionalProperties: false },
    executionMode: 'sequential',
    async execute(_id, params, signal, _update, ctx) {
      let value;
      if (params.options?.length) {
        const freeLabel = '自行填写';
        value = await ctx.ui.select(params.question, [...params.options, freeLabel], { signal });
        if (value === freeLabel) value = await ctx.ui.input(params.question, '', { signal });
      } else value = await ctx.ui.input(params.question, '', { signal });
      return { content: [{ type: 'text', text: value === undefined ? '用户取消了此问题，请勿假定用户已同意任何操作。' : value }],
        details: { cancelled: value === undefined } };
    },
  });
}
