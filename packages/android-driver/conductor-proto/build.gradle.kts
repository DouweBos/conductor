
plugins {
    java
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

tasks.named<Jar>("jar") {
    from("src/main/proto/conductor_android.proto")
}
