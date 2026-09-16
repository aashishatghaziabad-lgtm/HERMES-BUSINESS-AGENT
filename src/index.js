export default {
  async fetch(requests) {
    return new Response("Hermes Control is alive",{
      headers:{ "content-type":"text/plain"},
    });
  },
};
