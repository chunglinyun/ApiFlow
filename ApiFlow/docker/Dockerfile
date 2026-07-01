# syntax=docker/dockerfile:1
#
# Build context MUST be the TpPayment.Toolkits repo root (NOT this project folder),
# because ApiFlow references the sibling project Api.Common → COPY paths span both projects.
#
#   cd <TpPayment.Toolkits root>
#   docker build -t <registry>/apiflow:<stg-tag> -f ApiFlow/ApiFlow/Dockerfile .

# ---- Build stage ----
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

# Restore first (leverages layer caching when only source changes).
COPY ApiFlow/ApiFlow/ApiFlow.csproj ApiFlow/ApiFlow/
COPY ApiFlow/Api.Common/Api.Common.csproj ApiFlow/Api.Common/
RUN dotnet restore ApiFlow/ApiFlow/ApiFlow.csproj

# Copy the rest of the sources and publish.
COPY . .
RUN dotnet publish ApiFlow/ApiFlow/ApiFlow.csproj -c Release -o /app/publish --no-restore

# ---- Runtime stage ----
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS final
WORKDIR /app

# HTTP/1.1 REST listener.
ENV ASPNETCORE_HTTP_PORTS=5000
EXPOSE 5000

# curl is needed for the container HEALTHCHECK below (not in the base image).
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/publish .

# Liveness probe: GET /health → 200 {"status":"ok"}
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl --fail http://localhost:5000/health || exit 1

ENTRYPOINT ["dotnet", "ApiFlow.dll"]
