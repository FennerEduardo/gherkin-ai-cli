plugins { id("org.springframework.boot") version "3.5.0"; kotlin("jvm") version "2.2.0"; kotlin("plugin.spring") version "2.2.0" }
dependencies { implementation("org.springframework.boot:spring-boot-starter-web"); implementation("org.springframework.boot:spring-boot-starter-validation"); implementation("org.springframework.boot:spring-boot-starter-security") }
