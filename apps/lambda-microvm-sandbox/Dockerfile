FROM public.ecr.aws/lambda/microvms:al2023-minimal

RUN dnf install -y nodejs24 && dnf clean all
WORKDIR /app
COPY server.mjs /app/server.mjs
RUN mkdir -p /workspace/.sweatpants

ENV NODE_ENV=production
ENV SWEATPANTS_WORKSPACE=/workspace
EXPOSE 8080 9000
CMD ["node", "/app/server.mjs"]
