const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function handleReceptionistCall(userMessage) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [
      {
        role: 'system',
        content: 'You are a helpful AI receptionist for a restaurant. Answer calls professionally, take reservations, and answer questions about hours and menu.',
      },
      {
        role: 'user',
        content: userMessage,
      },
    ],
  });

  return response.choices[0].message.content;
}

module.exports = { handleReceptionistCall };