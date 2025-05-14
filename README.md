[![MAWESI](https://static.wixstatic.com/shapes/8b0a46_db7555b28aa448fe959f2dfc7c909e0a.svg)](https://www.mawesi.net)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/MAWESI-SAS/ORACLE_MCP)

# ORACLE_MCP

Un servidor que implementa el Model Context Protocol (MCP) para interactuar con bases de datos Oracle. Proporciona herramientas para ejecutar consultas SQL, administrar usuarios y explorar la estructura de la base de datos mediante una interfaz estándar MCP.

## Descripción

ORACLE_MCP es un servidor que facilita la comunicación con bases de datos Oracle a través del protocolo MCP (Model Context Protocol). Permite a los modelos de lenguaje o aplicaciones cliente interactuar con bases de datos Oracle de forma estructurada y segura, sin necesidad de conocer los detalles específicos de la implementación de Oracle.

El servidor proporciona diversas herramientas para:
- Ejecutar consultas SQL de solo lectura
- Ejecutar sentencias DDL/DML (CREATE, INSERT, UPDATE, etc.)
- Gestionar usuarios (crear, verificar existencia)
- Asignar privilegios a usuarios
- Obtener datos de muestra de tablas
- Explorar la estructura de tablas (columnas, claves primarias y foráneas)

## Requisitos previos

- Node.js (v14 o superior)
- Cliente Oracle Database (Oracle Instant Client)
- Acceso a una base de datos Oracle

## Instalación

1. Clonar el repositorio:
```bash
git clone https://github.com/MAWESI-SAS/ORACLE_MCP
cd ORACLE_MCP
```

2. Instalar dependencias:
```bash
npm install
```

3. Asegúrate de tener instalado el Oracle Instant Client y configuradas las variables de entorno correspondientes.

## Configuración

Si necesitas especificar la ubicación del cliente Oracle, puedes descomentar y modificar la siguiente línea en el archivo `main.ts`:

```typescript
// oracledb.initOracleClient({ libDir: '/path/to/instantclient' });
```

## Uso

El servidor se inicia proporcionando una cadena de conexión a Oracle como argumento:

```bash
node main.js usuario/contraseña@host:puerto/servicio
```

Ejemplo:
```bash
node main.js system/oracle123@localhost:1521/XEPDB1
```

### Formato de la cadena de conexión

La cadena de conexión debe seguir el formato:
```
usuario/contraseña@host:puerto/servicio
```

Donde:
- `usuario`: Nombre de usuario de Oracle
- `contraseña`: Contraseña del usuario
- `host`: Dirección IP o nombre del host donde se ejecuta la base de datos
- `puerto`: Puerto de escucha de Oracle (generalmente 1521)
- `servicio`: Nombre del servicio de base de datos

## Herramientas disponibles

El servidor proporciona las siguientes herramientas a través del protocolo MCP:

### 1. query

Ejecuta consultas SQL de solo lectura.

**Parámetros:**
- `sql`: Sentencia SQL a ejecutar (tipo: string, requerido)

### 2. execute

Ejecuta sentencias DDL/DML (CREATE, INSERT, UPDATE, etc.).

**Parámetros:**
- `sql`: Sentencia SQL a ejecutar (tipo: string, requerido)

### 3. check_user_exists

Verifica si un usuario existe en la base de datos.

**Parámetros:**
- `username`: Nombre del usuario a verificar (tipo: string, requerido)

### 4. create_user

Crea un nuevo usuario en la base de datos.

**Parámetros:**
- `username`: Nombre del usuario a crear (tipo: string, requerido)
- `password`: Contraseña del usuario (tipo: string, requerido)
- `tablespace`: Tablespace por defecto (tipo: string, por defecto: "USERS")
- `tempTablespace`: Tablespace temporal (tipo: string, por defecto: "TEMP")

### 5. grant_privileges

Otorga privilegios a un usuario existente.

**Parámetros:**
- `username`: Nombre del usuario al que se otorgarán privilegios (tipo: string, requerido)
- `privileges`: Lista de privilegios a otorgar (tipo: array de strings, requerido)

### 6. get_table_data

Obtiene datos de muestra de una tabla.

**Parámetros:**
- `tableName`: Nombre de la tabla (tipo: string, requerido)
- `limit`: Número máximo de filas a devolver (tipo: number, por defecto: 10)

## Recursos disponibles

El servidor también expone la estructura de las tablas como recursos. Estos recursos se pueden consultar para obtener información detallada sobre las columnas, claves primarias y foráneas de una tabla.

La URI de un recurso sigue el formato:
```
oracle://usuario@host:puerto/servicio/NOMBRE_TABLA/schema
```

## Características de seguridad

- Las consultas se ejecutan como transacciones de solo lectura cuando es apropiado
- Se aplica rollback automático para evitar cambios no deseados
- Las contraseñas no se incluyen en las URIs de los recursos
- Límite de filas en las consultas para evitar sobrecarga
- Manejo de errores detallado con sugerencias

## Pool de conexiones

El servidor utiliza un pool de conexiones para optimizar el rendimiento:

- Mínimo de conexiones: 1
- Máximo de conexiones: 5
- Incremento: 1
- Tiempo de espera del pool: 60 segundos
- Tiempo de espera de la cola: 60000 milisegundos

## Desarrollo

Este proyecto está implementado en TypeScript y utiliza el SDK de Model Context Protocol para la comunicación.

Para compilar el proyecto:
```bash
npm run build
```

## Licencia

Este proyecto está licenciado bajo la Licencia MIT - vea el archivo [LICENSE](LICENSE) para más detalles.

Copyright (c) 2025 MAWESI S.A.S.
